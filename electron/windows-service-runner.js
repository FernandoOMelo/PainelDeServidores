'use strict';

const { EventEmitter } = require('node:events');

const STATES = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  BACKOFF: 'backoff',
  CRASHED: 'crashed',
  PAUSED: 'paused',
};

/** Estado do servico no Windows -> estado no painel. */
function mapState(serviceState) {
  switch (String(serviceState || '').toLowerCase()) {
    case 'running':
      return STATES.RUNNING;
    case 'paused':
      return STATES.PAUSED;
    case 'start pending':
    case 'startpending':
      return STATES.STARTING;
    case 'stop pending':
    case 'stoppending':
    case 'continue pending':
      return STATES.STOPPING;
    case 'stopped':
      return STATES.STOPPED;
    default:
      return STATES.STOPPED;
  }
}

/** Estado do servico -> situacao de saude. */
function mapHealth(serviceState) {
  switch (String(serviceState || '').toLowerCase()) {
    case 'running':
      return 'healthy';
    case 'stopped':
      return 'unhealthy';
    default:
      return 'unknown';
  }
}

/**
 * Controla um servico do Windows (Service Control Manager) com a mesma
 * interface do ServiceRunner e do DockerRunner.
 */
class WindowsServiceRunner extends EventEmitter {
  constructor(service, options = {}) {
    super();
    this.service = service;
    this.client = options.client;
    this.state = STATES.STOPPED;
    this.serviceState = null;
    this.startMode = null;
    this.pid = null;
    this.path = null;
    this.health = 'unknown';
    this.healthDetail = null;
    this.startedAt = null;
    this.restartCount = 0;
    this.lastError = null;
    this.intentionalStop = false;
    this.nextRetryAt = null;
    this.observed = false;
    // Quando existe health check HTTP/TCP, ele e quem define a saude.
    this.healthFromService = options.healthFromService !== false;

    this._monitorTimer = null;
    this._backoffTimer = null;
    this.disposed = false;
  }

  get isActive() {
    return this.state === STATES.RUNNING || this.state === STATES.STARTING;
  }

  #emitState() {
    if (this.disposed) return;
    this.emit('state', this.snapshot());
  }

  snapshot() {
    return {
      id: this.service.id,
      state: this.state,
      type: 'servico',
      pid: this.pid,
      service: this.service.service,
      serviceState: this.serviceState,
      startMode: this.startMode,
      path: this.path,
      health: this.health,
      healthDetail: this.healthDetail,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      restartCount: this.restartCount,
      nextRetryAt: this.nextRetryAt,
      lastError: this.lastError,
    };
  }

  async start() {
    if (this.isActive) return;
    if (this.observed) {
      this.#appendLog('system', 'Servico somente monitorar: iniciar/parar esta desativado.');
      return;
    }

    this.intentionalStop = false;
    this.lastError = null;
    this.state = STATES.STARTING;
    this.#emitState();

    const result = await this.client.start(this.service.service);
    if (!result.ok) {
      this.state = STATES.CRASHED;
      this.lastError = result.error;
      this.#appendLog('system', `ERRO ao iniciar: ${result.error}`);
      this.#emitState();
      this.emit('notice', { level: 'error', message: result.error, needsElevation: result.needsElevation });
      return;
    }

    this.#appendLog('system', `Servico "${this.service.service}" iniciado.`);
    await this.client.waitForRunning(this.service.service, 60000);
    await this.#poll();
  }

  async stop() {
    if (this.observed) {
      this.#appendLog('system', 'Servico somente monitorar: parar esta desativado.');
      return;
    }

    this.intentionalStop = true;
    this.state = STATES.STOPPING;
    this.#emitState();

    const result = await this.client.stop(this.service.service);
    if (!result.ok) {
      this.lastError = result.error;
      this.#appendLog('system', `ERRO ao parar: ${result.error}`);
      this.state = STATES.CRASHED;
      this.#emitState();
      this.emit('notice', { level: 'error', message: result.error, needsElevation: result.needsElevation });
      return;
    }

    this.#appendLog('system', `Servico "${this.service.service}" encerrado.`);
    await this.#poll();
  }

  async restart() {
    this.intentionalStop = false;
    this.state = STATES.STOPPING;
    this.#emitState();

    const result = await this.client.restart(this.service.service);
    if (!result.ok) {
      this.lastError = result.error;
      this.state = STATES.CRASHED;
      this.#appendLog('system', `ERRO ao reiniciar: ${result.error}`);
      this.#emitState();
      this.emit('notice', { level: 'error', message: result.error, needsElevation: result.needsElevation });
      return;
    }

    this.#appendLog('system', `Servico "${this.service.service}" reiniciado.`);
    await this.client.waitForRunning(this.service.service, 60000);
    await this.#poll();
  }

  /**
   * Acompanha o servico sem agir sobre ele. Usado tanto no modo somente
   * monitorar quanto em servicos que o painel pode controlar - o servico
   * pode ter sido iniciado por fora, e o painel precisa enxergar isso.
   */
  monitor() {
    this.#startMonitor();
    this.#poll().catch(() => {});
  }

  /** Modo somente leitura: acompanha o servico sem iniciar/parar. */
  observe() {
    this.observed = true;
    this.monitor();
  }

  #startMonitor() {
    if (this._monitorTimer) return;
    this.#stopMonitor();
    const interval = this.service.health?.intervalMs ?? 5000;
    this._monitorTimer = setInterval(() => {
      this.#poll().catch(() => {});
    }, interval);
    this._monitorTimer.unref?.();
  }

  #stopMonitor() {
    if (this._monitorTimer) {
      clearInterval(this._monitorTimer);
      this._monitorTimer = null;
    }
  }

  async #poll() {
    let info;
    try {
      info = await this.client.get(this.service.service);
    } catch (err) {
      this.lastError = err.message;
      this.#emitState();
      return;
    }

    if (!info) {
      this.lastError = 'Servico nao encontrado no Windows.';
      this.health = 'unknown';
      this.#emitState();
      return;
    }

    const previousState = this.serviceState;
    this.serviceState = info.state;
    this.startMode = info.startMode;
    this.pid = info.pid || null;
    this.path = info.path || null;

    const mapped = mapState(info.state);
    this.state = mapped;
    if (mapped === STATES.RUNNING) {
      if (!this.startedAt) this.startedAt = Date.now();
    } else {
      this.startedAt = null;
    }

    const health = mapHealth(info.state);
    const healthChanged = health !== this.health;
    if (this.healthFromService) {
      this.health = health;
      this.healthDetail = { latencyMs: 0, error: null, status: info.state };
    }

    if (healthChanged && this.healthFromService) {
      this.emit('health', {
        id: this.service.id,
        ok: health === 'healthy',
        state: health,
        latencyMs: 0,
        error: null,
      });
    }

    // Parou sozinho: o restart automatico assume daqui.
    if (
      !this.intentionalStop &&
      !this.observed &&
      previousState === 'Running' &&
      mapped === STATES.STOPPED
    ) {
      this.#appendLog('system', 'Servico parou sozinho.');
      this.#scheduleRestart('servico parou');
    }

    this.#emitState();
  }

  #scheduleRestart(reason) {
    const cfg = this.service.restart || {};
    if (!cfg.enabled) {
      this.state = STATES.CRASHED;
      this.lastError = reason;
      this.#emitState();
      return;
    }
    if (this.restartCount >= cfg.maxRetries) {
      this.state = STATES.CRASHED;
      this.lastError = `Limite de ${cfg.maxRetries} reinicios excedido (${reason})`;
      this.#emitState();
      return;
    }

    this.restartCount += 1;
    const delay = Math.min(cfg.maxBackoffMs, cfg.backoffMs * 2 ** (this.restartCount - 1));
    this.nextRetryAt = Date.now() + delay;
    this.state = STATES.BACKOFF;
    this.lastError = reason;
    this.#emitState();

    this._backoffTimer = setTimeout(() => {
      this._backoffTimer = null;
      this.nextRetryAt = null;
      this.intentionalStop = false;
      this.start();
    }, delay);
    this._backoffTimer.unref?.();
  }

  #appendLog(stream, text) {
    this.emit('log', [{ ts: Date.now(), stream, text }]);
  }

  getLogs() {
    return [];
  }

  clearLogs() {}

  dispose() {
    this.disposed = true;
    if (this._backoffTimer) clearTimeout(this._backoffTimer);
    this.#stopMonitor();
  }
}

module.exports = { WindowsServiceRunner, SERVICE_STATES: STATES, mapState, mapHealth };

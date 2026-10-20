'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const STATES = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  BACKOFF: 'backoff',
  CRASHED: 'crashed',
};

/**
 * Controla um container Docker com a mesma interface do ServiceRunner:
 * start/stop/restart, logs ao vivo, estado e metricas.
 */
class DockerRunner extends EventEmitter {
  constructor(service, options = {}) {
    super();
    this.service = service;
    this.docker = options.docker;
    this.state = STATES.STOPPED;
    this.containerState = null;
    this.health = 'unknown';
    this.healthDetail = null;
    this.image = null;
    this.ports = [];
    this.exitCode = null;
    this.startedAt = null;
    this.restartCount = 0;
    this.lastError = null;
    this.intentionalStop = false;
    this.nextRetryAt = null;
    this.observed = false;

    this.maxLogs = options.maxLogs ?? 2000;
    this.logs = [];
    this.logSeq = 0;
    this.logDir = options.logDir;

    this._monitorTimer = null;
    this._statsTimer = null;
    this._logProcess = null;
    this._backoffTimer = null;
    this._logStream = null;
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
      type: 'docker',
      pid: null,
      container: this.service.container,
      containerState: this.containerState,
      image: this.image,
      ports: this.ports,
      health: this.health,
      healthDetail: this.healthDetail,
      exitCode: this.exitCode,
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
      // Em modo somente monitorar o painel nao controla o container.
      this.#appendLog('system', 'Servico somente monitorar: iniciar/parar esta desativado.');
      return;
    }
    this.intentionalStop = false;
    this.lastError = null;
    this.state = STATES.STARTING;
    this.#emitState();

    try {
      await this.docker.start(this.service.container);
      this.state = STATES.RUNNING;
      this.startedAt = Date.now();
      this.exitCode = null;
      this.restartCount = 0;
      this.#appendLog('system', `Container "${this.service.container}" iniciado.`);
    } catch (err) {
      this.state = STATES.CRASHED;
      this.lastError = err.message;
      this.#appendLog('system', `ERRO ao iniciar container: ${err.message}`);
    }

    this.#emitState();
    this.#startMonitor();
    this.#startLogs();
    this.#startStats();
  }

  async stop() {
    if (this.observed) {
      this.#appendLog('system', 'Servico somente monitorar: parar esta desativado.');
      return;
    }
    this.intentionalStop = true;
    this.#clearBackoff();
    this.state = STATES.STOPPING;
    this.#emitState();

    try {
      await this.docker.stop(this.service.container);
      this.state = STATES.STOPPED;
      this.startedAt = null;
      this.#appendLog('system', `Container "${this.service.container}" encerrado.`);
    } catch (err) {
      this.lastError = err.message;
      this.#appendLog('system', `ERRO ao parar container: ${err.message}`);
      this.state = STATES.CRASHED;
    }

    this.#stopMonitor();
    this.#stopLogs();
    this.#stopStats();
    this.#emitState();
  }

  async restart() {
    this.intentionalStop = false;
    this.state = STATES.STOPPING;
    this.#emitState();
    try {
      await this.docker.restart(this.service.container);
      this.state = STATES.RUNNING;
      this.startedAt = Date.now();
      this.exitCode = null;
      this.#appendLog('system', `Container "${this.service.container}" reiniciado.`);
    } catch (err) {
      this.state = STATES.CRASHED;
      this.lastError = err.message;
      this.#appendLog('system', `ERRO ao reiniciar container: ${err.message}`);
    }
    this.#emitState();
    this.#startMonitor();
    this.#startLogs();
    this.#startStats();
  }

  /* ---------------- monitoramento ---------------- */

  /**
   * Modo somente leitura: acompanha o container (estado, health, logs e
   * metricas) sem nunca iniciar, parar ou reiniciar.
   */
  observe() {
    this.observed = true;
    this.#startMonitor();
    this.#startLogs();
    this.#startStats();
    this.#poll().catch(() => {});
  }

  #startMonitor() {
    this.#stopMonitor();
    const interval = this.service.health?.intervalMs ?? 5000;
    this._monitorTimer = setInterval(() => {
      this.#poll().catch(() => {});
    }, interval);
    this._monitorTimer.unref?.();
    this.#poll().catch(() => {});
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
      info = await this.docker.inspect(this.service.container);
    } catch (err) {
      this.lastError = err.message;
      this.#emitState();
      return;
    }

    this.containerState = info.state;
    this.image = info.image;
    this.ports = info.ports;
    this.exitCode = info.exitCode;

    const health = info.health === 'healthy' ? 'healthy' : info.health === 'unhealthy' ? 'unhealthy' : 'unknown';
    const healthChanged = health !== this.health;
    this.health = health;
    this.healthDetail = {
      latencyMs: 0,
      error: info.healthLog || null,
      status: info.health,
    };

    if (info.running) {
      if (this.state !== STATES.RUNNING) {
        this.state = STATES.RUNNING;
        this.startedAt = info.startedAt ? new Date(info.startedAt).getTime() : Date.now();
      }
    } else if (this.state === STATES.RUNNING || this.state === STATES.STARTING) {
      // Saiu sozinho: o restart automatico assume daqui.
      this.state = STATES.STOPPED;
      this.startedAt = null;
      if (!this.intentionalStop && !this.observed) {
        this.#appendLog('system', `Container parou sozinho (exit ${info.exitCode}).`);
        this.#scheduleRestart(`container parou com codigo ${info.exitCode}`);
      }
    }

    if (healthChanged) {
      this.emit('health', {
        id: this.service.id,
        ok: health === 'healthy',
        state: health,
        latencyMs: 0,
        error: info.healthLog || null,
      });
    }

    this.#emitState();
  }

  #startStats() {
    this.#stopStats();
    const interval = Math.max(2000, this.service.health?.intervalMs ?? 5000);
    this._statsTimer = setInterval(() => {
      this.docker
        .stats(this.service.container)
        .then((stats) => {
          if (stats) this.emit('metrics', [{ id: this.service.id, ...stats }]);
        })
        .catch(() => {});
    }, interval);
    this._statsTimer.unref?.();
  }

  #stopStats() {
    if (this._statsTimer) {
      clearInterval(this._statsTimer);
      this._statsTimer = null;
    }
  }

  /* ---------------- auto-restart ---------------- */

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
      this.#appendLog('system', this.lastError);
      this.#emitState();
      this.emit('restart-exhausted', { reason });
      return;
    }

    this.restartCount += 1;
    const delay = Math.min(cfg.maxBackoffMs, cfg.backoffMs * 2 ** (this.restartCount - 1));
    this.nextRetryAt = Date.now() + delay;
    this.state = STATES.BACKOFF;
    this.lastError = reason;
    this.#appendLog('system', `Reiniciando container em ${Math.round(delay / 1000)}s (tentativa ${this.restartCount}/${cfg.maxRetries}).`);
    this.#emitState();

    this._backoffTimer = setTimeout(() => {
      this._backoffTimer = null;
      this.nextRetryAt = null;
      this.intentionalStop = false;
      this.start();
    }, delay);
    this._backoffTimer.unref?.();
  }

  #clearBackoff() {
    if (this._backoffTimer) {
      clearTimeout(this._backoffTimer);
      this._backoffTimer = null;
    }
    this.nextRetryAt = null;
  }

  /* ---------------- logs ---------------- */

  #startLogs() {
    this.#stopLogs();

    let child;
    try {
      child = this.docker.streamLogs(this.service.container, { tail: 200 });
    } catch (err) {
      this.#appendLog('system', `ERRO ao abrir logs: ${err.message}`);
      return;
    }

    this._logProcess = child;
    this.#openLogFile();

    const consume = (stream, chunk) => {
      const text = chunk.toString();
      const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
      if (lines.length) {
        this.#pushLogs(lines.map((line) => ({ ts: Date.now(), stream, text: line })));
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => consume('stdout', chunk));
    child.stderr?.on('data', (chunk) => consume('stderr', chunk));

    child.on('exit', () => {
      if (this._logProcess === child) this._logProcess = null;
    });
  }

  #stopLogs() {
    if (this._logProcess) {
      try {
        this._logProcess.kill();
      } catch {
        /* ignorado */
      }
      this._logProcess = null;
    }
  }

  #openLogFile() {
    if (this._logStream) return;
    try {
      const dir = this.logDir || path.join(process.cwd(), 'logs');
      fs.mkdirSync(dir, { recursive: true });
      this._logStream = fs.createWriteStream(path.join(dir, `${this.service.id}.log`), { flags: 'a' });
    } catch {
      this._logStream = null;
    }
  }

  #appendLog(stream, text) {
    this.#pushLogs([{ ts: Date.now(), stream, text }]);
  }

  #pushLogs(entries) {
    for (const entry of entries) {
      entry.seq = ++this.logSeq;
      this.logs.push(entry);
      try {
        this._logStream?.write(`[${new Date(entry.ts).toISOString()}] ${entry.stream}: ${entry.text}\n`);
      } catch {
        /* stream encerrado */
      }
    }
    const excess = this.logs.length - this.maxLogs;
    if (excess > 0) this.logs.splice(0, excess);
    this.emit('log', entries);
  }

  getLogs() {
    return this.logs;
  }

  clearLogs() {
    this.logs = [];
    this.emit('log', []);
  }

  dispose() {
    this.disposed = true;
    this.#clearBackoff();
    this.#stopMonitor();
    this.#stopStats();
    this.#stopLogs();
    try {
      this._logStream?.end();
    } catch {
      /* ignorado */
    }
    this._logStream = null;
  }
}

module.exports = { DockerRunner, DOCKER_STATES: STATES };

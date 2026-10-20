'use strict';

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { resolveExecution, detectNodeVersion } = require('./executables');

const STATES = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  BACKOFF: 'backoff',
  CRASHED: 'crashed',
};

/**
 * Controla o ciclo de vida de um processo servidor:
 * spawn -> captura de logs -> deteccao de saida unexpected -> restart com backoff.
 */
class ServiceRunner extends EventEmitter {
  constructor(service, options = {}) {
    super();
    this.service = service;
    this.state = STATES.STOPPED;
    this.child = null;
    this.pid = null;
    this.exitCode = null;
    this.exitSignal = null;
    this.startedAt = null;
    this.restartCount = 0;
    this.lastError = null;
    this.intentionalStop = false;
    this.nextRetryAt = null;
    this.nodePath = null;
    this.nodeVersion = null;

    this.maxLogs = options.maxLogs ?? 2000;
    this.logs = [];
    this.logSeq = 0;

    this._backoffTimer = null;
    this._stabilityTimer = null;
    this._logStream = null;
    this._partial = { stdout: '', stderr: '' };
    this._stopResolve = null;
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
      type: 'processo',
      pid: this.pid,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      restartCount: this.restartCount,
      nextRetryAt: this.nextRetryAt,
      lastError: this.lastError,
      nodePath: this.nodePath,
      nodeVersion: this.nodeVersion,
    };
  }

  #openLogFile() {
    try {
      const dir = path.join(this.options?.logDir || '.', 'logs');
      fs.mkdirSync(dir, { recursive: true });
      this._logStream = fs.createWriteStream(path.join(dir, `${this.service.id}.log`), { flags: 'a' });
    } catch {
      this._logStream = null;
    }
  }

  setOptions(options) {
    this.options = options;
    if (this.maxLogs !== options.maxLogs) {
      this.maxLogs = options.maxLogs;
      this.#trimLogs();
    }
  }

  start() {
    if (this.isActive) return;
    // Ja existe um processo vivo (em transicao de parada): nao duplica.
    if (this.child) return;
    if (this.state === STATES.BACKOFF) this.#clearBackoff();

    this.intentionalStop = false;
    this.lastError = null;
    this.exitCode = null;
    this.exitSignal = null;
    this.state = STATES.STARTING;
    this.#emitState();

    if (!this.service.command) {
      this.lastError = 'Comando nao configurado';
      this.state = STATES.CRASHED;
      this.#appendLog('system', `ERRO: ${this.lastError}`);
      this.#emitState();
      return;
    }

    if (!this._logStream) this.#openLogFile();

    const cwd = this.#resolveCwd();
    const execution = resolveExecution(this.service, this.options?.appRoot || process.cwd());
    const env = { ...process.env, ...execution.env, ...this.service.env, FORCE_COLOR: '1' };

    if (execution.warning) this.#appendLog('system', execution.warning);

    this.nodePath = execution.nodePath;
    if (execution.nodePath) {
      detectNodeVersion(execution.nodePath).then((version) => {
        this.nodeVersion = version;
        this.#emitState();
      });
    }

    let child;
    try {
      child = spawn(execution.command, execution.args, {
        cwd,
        env,
        shell: this.service.shell,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.lastError = err.message;
      this.state = STATES.CRASHED;
      this.#appendLog('system', `ERRO ao iniciar: ${err.message}`);
      this.#emitState();
      return;
    }

    this.child = child;
    this.pid = child.pid ?? null;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => this.#consume('stdout', chunk));
    child.stderr?.on('data', (chunk) => this.#consume('stderr', chunk));

    child.on('error', (err) => {
      this.lastError = err.message;
      this.#appendLog('system', `ERRO: ${err.message}`);
      if (err.code === 'ENOENT') {
        this.state = STATES.CRASHED;
        this.child = null;
        this.pid = null;
        this.#emitState();
        this._stopResolve?.();
        this._stopResolve = null;
      }
    });

    child.on('spawn', () => {
      if (this.state === STATES.STARTING) {
        this.state = STATES.RUNNING;
        this.startedAt = Date.now();
        this.#appendLog('system', `Iniciado: ${this.#commandLine()}`);
        if (this.nodePath) {
          this.#appendLog('system', `Node: ${this.nodePath}`);
        }
        this.#emitState();
      }
      this.#armStabilityTimer();
    });

    child.on('exit', (code, signal) => {
      // Ignora a saida de processos obsoletos (runner substituido por update).
      if (this.child !== child) {
        this._stopResolve?.();
        this._stopResolve = null;
        return;
      }

      const wasIntentional = this.intentionalStop;
      this.exitCode = code;
      this.exitSignal = signal;
      this.child = null;
      this.pid = null;
      this.startedAt = null;
      this.#clearStabilityTimer();

      if (wasIntentional) {
        this.state = STATES.STOPPED;
        this.#appendLog('system', 'Parado pelo usuario.');
        this.#emitState();
        this._stopResolve?.();
        this._stopResolve = null;
        return;
      }

      const reason = signal ? `sinal ${signal}` : `codigo ${code}`;
      this.#appendLog('system', `Processo encerrado inesperadamente (${reason}).`);
      this.#emitState();
      this.#scheduleRestart(`processo encerrado (${reason})`);
    });
  }

  stop() {
    this.intentionalStop = true;
    this.#clearBackoff();
    this.#clearStabilityTimer();
    this.restartCount = 0;
    this.nextRetryAt = null;

    if (!this.child) {
      this.state = STATES.STOPPED;
      this.#emitState();
      return Promise.resolve();
    }

    this.state = STATES.STOPPING;
    this.#emitState();
    this.#killTree(this.child.pid);

    const forceTimer = setTimeout(() => {
      if (this.child) {
        this.#appendLog('system', 'Processo nao encerrou a tempo, forcando SIGKILL.');
        try {
          this.child.kill('SIGKILL');
        } catch {
          /* processo ja encerrado */
        }
      }
    }, 5000);
    forceTimer.unref?.();

    return new Promise((resolve) => {
      this._stopResolve = resolve;
    });
  }

  async restart() {
    await this.stop();
    this.intentionalStop = false;
    this.start();
  }

  /**
   * Modo somente leitura: o painel nao controla o processo. Para processos
   * externos nao existe PID a acompanhar, entao o acompanhamento se da pelo
   * health check de porta configurado no servico.
   */
  observe() {
    this.observed = true;
    this.state = STATES.STOPPED;
    this.#emitState();
  }

  #killTree(pid) {
    if (!pid) return;
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      } catch {
        /* fallback abaixo */
      }
      try {
        this.child?.kill('SIGTERM');
      } catch {
        /* ignorado */
      }
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          this.child?.kill('SIGTERM');
        } catch {
          /* ignorado */
        }
      }
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* ja encerrado */
        }
      }, 3000).unref?.();
    }
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
    this.#appendLog('system', `Reiniciando em ${Math.round(delay / 1000)}s (tentativa ${this.restartCount}/${cfg.maxRetries}).`);
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

  #armStabilityTimer() {
    this.#clearStabilityTimer();
    const ms = this.service.restart?.stabilityMs ?? 60000;
    this._stabilityTimer = setTimeout(() => {
      this._stabilityTimer = null;
      if (this.state === STATES.RUNNING) {
        this.restartCount = 0;
        this.#emitState();
      }
    }, ms);
    this._stabilityTimer.unref?.();
  }

  #clearStabilityTimer() {
    if (this._stabilityTimer) {
      clearTimeout(this._stabilityTimer);
      this._stabilityTimer = null;
    }
  }

  #commandLine() {
    const parts = [this.service.command, ...(this.service.args || [])];
    return parts.join(' ');
  }

  /**
   * Resolve o diretorio de trabalho: caminho relativo e ancorado na pasta do
   * app; caminho absoluto e usado como veio. Se nao existir, cai na pasta do app
   * e avisa no log em vez de falhar silenciosamente.
   */
  #resolveCwd() {
    const root = this.options?.appRoot || process.cwd();
    const configured = this.service.cwd;
    const target = configured ? path.resolve(root, configured) : root;

    if (!fs.existsSync(target)) {
      this.#appendLog('system', `Diretorio de trabalho "${configured}" nao encontrado; usando a pasta do app.`);
      return root;
    }
    return target;
  }

  #consume(stream, chunk) {
    const buf = this._partial[stream] + chunk;
    const lines = buf.split(/\r?\n/);
    this._partial[stream] = lines.pop() ?? '';
    const entries = lines
      .filter((line) => line.length > 0)
      .map((line) => ({ ts: Date.now(), stream, text: line }));
    if (entries.length) this.#pushLogs(entries);
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
        /* stream encerrado: logs seguem apenas em memoria */
      }
    }
    this.#trimLogs();
    this.emit('log', entries);
  }

  #trimLogs() {
    const excess = this.logs.length - this.maxLogs;
    if (excess > 0) this.logs.splice(0, excess);
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
    this.#clearStabilityTimer();
    this.intentionalStop = true;
    if (this.child) this.#killTree(this.child.pid);
    try {
      this._logStream?.end();
    } catch {
      /* ignorado */
    }
    this._logStream = null;
  }
}

module.exports = { ServiceRunner, STATES };

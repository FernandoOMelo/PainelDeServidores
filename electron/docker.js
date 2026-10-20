'use strict';

const { execFile, spawn } = require('node:child_process');
const { DockerApi } = require('./docker-api');

/**
 * Cliente do Docker.
 *
 * Prefere a API do Engine (pelo named pipe) e usa a CLI como reserva.
 * A diferenca importa: cada docker.exe custa ~20 MB, e o painel spawna
 * varios (um por container em logs e stats). Pela API nada e spawned.
 */
class DockerClient {
  constructor(options = {}) {
    this.binary = options.binary || 'docker';
    this.api = new DockerApi({ pipes: options.pipes });
    this._apiBroken = false;
  }

  exec(bin, args, { timeout = 20000 } = {}) {
    return new Promise((resolve) => {
      execFile(
        bin,
        args,
        { windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          resolve({ code: err?.code ?? 0, stdout: stdout || '', stderr: stderr || '' });
        }
      );
    });
  }

  /** Verifica se a CLI existe e se o daemon responde. */
  async availability() {
    if (this._apiBroken === false) {
      try {
        const info = await this.api.request('/version');
        if (info?.Version) {
          this._apiBroken = false;
          return { ok: true, version: info.Version, via: 'api' };
        }
      } catch {
        this._apiBroken = true;
      }
    }

    try {
      const { code, stdout } = await this.exec(this.binary, ['version', '--format', '{{.Server.Version}}'], {
        timeout: 10000,
      });
      if (code === 0 && stdout.trim()) {
        return { ok: true, version: stdout.trim(), via: 'cli' };
      }
    } catch {
      /* sem CLI */
    }

    return {
      ok: false,
      error: 'Docker nao encontrado ou daemon parado',
    };
  }

  /* --------------------------- operacoes --------------------------- */

  async listContainers() {
    if (!this._apiBroken) {
      try {
        return await this.api.listContainers();
      } catch {
        this._apiBroken = true;
      }
    }

    const { code, stdout } = await this.exec(this.binary, ['ps', '-a', '--format', '{{json .}}']);
    if (code !== 0 || !stdout.trim()) return [];

    return stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          const row = JSON.parse(line);
          return {
            id: row.ID,
            name: row.Names,
            image: row.Image,
            state: (row.State || '').toLowerCase(),
            status: row.Status,
            ports: row.Ports,
            createdAt: row.CreatedAt,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  async inspect(container) {
    if (!this._apiBroken) {
      try {
        return await this.api.inspect(container);
      } catch {
        this._apiBroken = true;
      }
    }

    const { code, stdout } = await this.exec(this.binary, [
      'inspect',
      container,
      '--format',
      '{{json .}}',
    ]);
    if (code !== 0 || !stdout.trim()) return null;

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return null;
    }

    // Com --format a saida e um objeto por container; sem ele, um array.
    const info = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!info?.Name) return null;

    const state = info.State || {};
    const health = state.Health || null;
    const ports = [];

    for (const [containerPort, bindings] of Object.entries(info.NetworkSettings?.Ports || {})) {
      if (!bindings?.length) {
        ports.push({ port: containerPort, published: null, host: null });
        continue;
      }
      for (const binding of bindings) {
        ports.push({ port: containerPort, published: binding.HostPort, host: binding.HostIp });
      }
    }

    return {
      id: info.Id?.slice(0, 12),
      name: info.Name?.replace(/^\//, ''),
      image: info.Config?.Image,
      state: (state.Status || '').toLowerCase(),
      running: Boolean(state.Running),
      exitCode: state.ExitCode,
      startedAt: state.StartedAt,
      finishedAt: state.FinishedAt,
      health: health ? health.Status.toLowerCase() : null,
      healthLog: health?.Log?.slice(-1)?.[0]?.Output?.trim() || null,
      restartCount: state.Restarting ? 1 : 0,
      ports,
    };
  }

  async start(container) {
    if (!this._apiBroken) {
      try {
        await this.api.start(container);
        return;
      } catch {
        this._apiBroken = true;
      }
    }
    await this.exec(this.binary, ['start', container]);
  }

  async stop(container, { timeout = 10 } = {}) {
    if (!this._apiBroken) {
      try {
        await this.api.stop(container, { timeout });
        return;
      } catch {
        this._apiBroken = true;
      }
    }
    await this.exec(this.binary, ['stop', '-t', String(timeout), container], { timeout: (timeout + 20) * 1000 });
  }

  async restart(container) {
    if (!this._apiBroken) {
      try {
        await this.api.restart(container);
        return;
      } catch {
        this._apiBroken = true;
      }
    }
    await this.exec(this.binary, ['restart', container], { timeout: 60000 });
  }

  async stats(container) {
    if (!this._apiBroken) {
      try {
        return await this.api.stats(container);
      } catch {
        this._apiBroken = true;
      }
    }

    const { code, stdout } = await this.exec(this.binary, [
      'stats',
      '--no-stream',
      '--format',
      '{{json .}}',
      container,
    ]);
    if (code !== 0 || !stdout.trim()) return null;

    let parsed;
    try {
      parsed = JSON.parse(stdout.split(/\r?\n/)[0]);
    } catch {
      return null;
    }

    return {
      cpu: parsePercent(parsed.CPUPerc),
      mem: parseSize(parsed.MemUsage),
      memPercent: parsePercent(parsed.MemPerc),
    };
  }

  /**
   * Stream de logs. Pela API vem um stream multiplexado; pela CLI, um
   * processo docker.exe. Os dois entregam os mesmos eventos.
   */
  streamLogs(container, { tail = 200 } = {}) {
    if (!this._apiBroken) {
      try {
        const stream = this.api.streamLogs(container, { tail });
        // A API pode falhar depois de connected; nesse caso o runner
        // simplesmente nao recebe logs, mas o servico segue monitorado.
        return stream;
      } catch {
        this._apiBroken = true;
      }
    }

    return spawn(this.binary, ['logs', '--tail', String(tail), '-f', container], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
}

/** Estado numerico do sc.exe -> nome oficial do estado. */
const STATE_NAMES = {
  1: 'Stopped',
  2: 'Start Pending',
  3: 'Stop Pending',
  4: 'Running',
  5: 'Continue Pending',
  6: 'Pause Pending',
  7: 'Paused',
};

/** Traduz os codigos do sc.exe em mensagens uteis. */
function translateScError(code, output) {
  switch (code) {
    case 5:
      return 'Acesso negado ao abrir o servico. Reinicie o painel como administrador para poder iniciar ou parar servicos do Windows.';
    case 1056:
      return 'O servico ja esta em execucao.';
    case 1057:
      return 'O servico nao foi iniciado.';
    case 1058:
      return 'O servico esta desabilitado.';
    case 1060:
      return 'O servico nao existe.';
    case 1061:
      return 'O servico foi marcado para exclusao.';
    case 1062:
      return 'O servico nao esta em execucao.';
    case 1053:
      return 'O servico nao respondeu a tempo para iniciar ou parar.';
    default:
      return output || `Falha (codigo ${code}) ao controlar o servico.`;
  }
}

function parsePercent(value) {
  const num = parseFloat(String(value ?? '').replace('%', ''));
  return Number.isFinite(num) ? Math.round(num * 10) / 10 : 0;
}

/** Converte "45.2MiB / 7.6GiB" em megabytes. */
function parseSize(value) {
  const first = String(value ?? '').split('/')[0].trim();
  const match = first.match(/^([\d.]+)\s*([a-zA-Z]*)$/);
  if (!match) return 0;

  const amount = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const factors = {
    '': 1 / (1024 * 1024),
    b: 1 / (1024 * 1024),
    kb: 1 / 1024,
    k: 1 / 1024,
    kib: 1 / 1024,
    mb: 1,
    m: 1,
    mib: 1,
    gb: 1024,
    g: 1024,
    gib: 1024,
    tb: 1024 * 1024,
    tib: 1024 * 1024,
  };
  const factor = factors[unit];
  if (!Number.isFinite(amount) || factor === undefined) return 0;
  return Math.round(amount * factor * 10) / 10;
}

module.exports = { DockerClient, parseSize, parsePercent, STATE_NAMES, translateScError };

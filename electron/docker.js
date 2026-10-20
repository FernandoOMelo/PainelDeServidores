'use strict';

const { execFile, spawn } = require('node:child_process');

/**
 * Cliente da CLI do Docker. Usa a CLI (instalada junto com o Docker Desktop)
 * em vez da API HTTP para nao depender de socket, TLS ou de versao.
 */
class DockerClient {
  constructor(options = {}) {
    this.binary = options.binary || 'docker';
    this._availability = null;
  }

  run(args, { timeout = 20000 } = {}) {
    return new Promise((resolve, reject) => {
      execFile(
        this.binary,
        args,
        { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const detail = (stderr || '').toString().trim() || err.message;
            reject(new Error(detail));
            return;
          }
          resolve(stdout.toString());
        }
      );
    });
  }

  /** Verifica se a CLI existe e se o daemon responde. */
  async availability() {
    if (this._availability) return this._availability;

    try {
      const server = await this.run(['version', '--format', '{{.Server.Version}}'], { timeout: 10000 });
      this._availability = { ok: true, version: server.trim() };
    } catch (err) {
      this._availability = {
        ok: false,
        error: err.message.includes('docker') ? err.message : 'Docker nao encontrado ou daemon parado',
      };
    }
    return this._availability;
  }

  /** Lista containers (rodando e parados). */
  async listContainers() {
    const out = await this.run(['ps', '-a', '--format', '{{json .}}']);
    const rows = out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    return rows.map((row) => ({
      id: row.ID,
      name: row.Names,
      image: row.Image,
      command: row.Command,
      state: (row.State || '').toLowerCase(),
      status: row.Status,
      ports: row.Ports,
      createdAt: row.CreatedAt,
    }));
  }

  /** Estado detalhado de um container (inclui healthcheck e exit code). */
  async inspect(container) {
    const raw = await this.run(['inspect', container, '--format', '{{json .}}'], { timeout: 15000 });
    const parsed = JSON.parse(raw);

    // Com --format a saida e um objeto por container; sem ele, um array.
    const info = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!info) throw new Error(`Container nao encontrado: ${container}`);

    const state = info.State || {};
    const health = state.Health || null;
    const bindings = info.NetworkSettings?.Ports || {};

    const ports = [];
    const seenPublished = new Set();
    for (const [containerPort, hosts] of Object.entries(bindings)) {
      if (!hosts?.length) {
        ports.push({ port: containerPort, published: null, host: null });
        continue;
      }
      for (const host of hosts) {
        // A mesma porta costuma estar publicada em IPv4 e IPv6: mostra uma vez.
        const key = `${containerPort}->${host.HostPort}`;
        if (seenPublished.has(key)) continue;
        seenPublished.add(key);
        ports.push({ port: containerPort, published: host.HostPort, host: host.HostIp });
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
    await this.run(['start', container]);
  }

  async stop(container, { timeout = 10 } = {}) {
    await this.run(['stop', '-t', String(timeout), container], { timeout: (timeout + 20) * 1000 });
  }

  async restart(container) {
    await this.run(['restart', container], { timeout: 60000 });
  }

  /** Estatisticas de recurso de um container (CPU% e memoria usada). */
  async stats(container) {
    const out = await this.run(
      ['stats', '--no-stream', '--format', '{{json .}}', container],
      { timeout: 15000 }
    );
    const line = out.split(/\r?\n/).filter(Boolean)[0];
    if (!line) return null;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }

    return {
      cpu: parsePercent(parsed.CPUPerc),
      mem: parseSize(parsed.MemUsage),
      memPercent: parsePercent(parsed.MemPerc),
      net: parsed.NetIO || null,
      blockIo: parsed.BlockIO || null,
    };
  }

  /** Fluxo de logs do container (equivalente a `docker logs -f`). */
  streamLogs(container, { tail = 200 } = {}) {
    return spawn(this.binary, ['logs', '--tail', String(tail), '-f', container], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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

module.exports = { DockerClient, parseSize, parsePercent };

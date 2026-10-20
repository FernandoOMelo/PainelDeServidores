'use strict';

const net = require('node:net');
const { EventEmitter } = require('node:events');

/**
 * Cliente da API do Docker Engine pelo named pipe do Windows.
 *
 * Falar com a API evita subir um docker.exe por operacao - cada CLI
 * custava ~20 MB de memoria, e o painel spawna varios (stats e logs de
 * cada container). O pipe e o mesmo que a CLI usaria.
 */
const PIPES = ['\\\\.\\pipe\\docker_engine', '\\\\.\\pipe\\dockerDesktopLinuxEngine'];
const API_VERSION = 'v1.43';

class DockerApi extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pipes = options.pipes || PIPES;
    this.pipe = null;
    this.apiVersion = API_VERSION;
  }

  /** Descobre um pipe que responda. */
  async connect() {
    if (this.pipe) return this.pipe;

    for (const pipe of this.pipes) {
      const ok = await this.#ping(pipe);
      if (ok) {
        this.pipe = pipe;
        return pipe;
      }
    }
    throw new Error('Nao foi possivel conectar a API do Docker (named pipe indisponivel).');
  }

  #ping(pipe) {
    return new Promise((resolve) => {
      const socket = net.connect(pipe);
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 4000);
      socket.on('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  /**
   * Executa uma requisicao e devolve o corpo ja decodificado.
   * O Docker responde com chunked encoding, entao o corpo vem em pedaços.
   */
  async request(path, { method = 'GET', body = null } = {}) {
    await this.connect();

    return new Promise((resolve, reject) => {
      const socket = net.connect(this.pipe);
      const chunks = [];
      let buffer = Buffer.alloc(0);
      let headerEnd = -1;
      let chunked = false;
      let failed = false;

      const timer = setTimeout(() => {
        failed = true;
        socket.destroy();
        reject(new Error(`Tempo esgotado na API do Docker: ${path}`));
      }, 30000);

      socket.on('connect', () => {
        const payload = body ? JSON.stringify(body) : '';
        const headers = [
          `${method} ${path.startsWith('/v1.') ? path : `/${API_VERSION}${path}`} HTTP/1.1`,
          'Host: docker',
          'Accept: application/json',
          'Connection: close',
        ];
        if (payload) {
          headers.push('Content-Type: application/json');
          headers.push(`Content-Length: ${Buffer.byteLength(payload)}`);
        }
        socket.write(`${headers.join('\r\n')}\r\n\r\n${payload}`);
      });

      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);

        if (headerEnd === -1) {
          headerEnd = buffer.indexOf('\r\n\r\n');
          if (headerEnd === -1) return;
          const headers = buffer.slice(0, headerEnd).toString('utf8');
          chunked = /transfer-encoding:\s*chunked/i.test(headers);
          buffer = buffer.slice(headerEnd + 4);
        }

        const decoded = chunked ? decodeChunked(buffer) : buffer;
        if (decoded) chunks.push(decoded);
        buffer = chunked ? Buffer.alloc(0) : buffer;
      });

      socket.on('error', (err) => {
        if (failed) return;
        failed = true;
        clearTimeout(timer);
        reject(err);
      });

      socket.on('close', () => {
        if (failed) return;
        failed = true;
        clearTimeout(timer);
        if (headerEnd === -1) {
          reject(new Error('Resposta invalida da API do Docker.'));
          return;
        }
        const raw = chunked ? Buffer.concat(chunks) : Buffer.concat([...chunks, buffer]);
        const text = raw.toString('utf8');
        try {
          resolve(text ? JSON.parse(text) : null);
        } catch {
          resolve(text);
        }
      });
    });
  }

  /* --------------------------- operacoes --------------------------- */

  async listContainers() {
    const rows = await this.request('/containers/json?all=1');
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => ({
      id: row.Id,
      name: (row.Names?.[0] || '').replace(/^\//, ''),
      image: row.Image,
      state: (row.State || '').toLowerCase(),
      status: row.Status,
      ports: (row.Ports || [])
        .map((p) => (p.PublicPort ? `${p.PublicPort}:${p.PrivatePort}` : `${p.PrivatePort}`))
        .join(', '),
      createdAt: row.Created,
    }));
  }

  async inspect(container) {
    const info = await this.request(`/containers/${encodeURIComponent(container)}/json`);
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
    await this.request(`/containers/${encodeURIComponent(container)}/start`, { method: 'POST' });
  }

  async stop(container, { timeout = 10 } = {}) {
    await this.request(`/containers/${encodeURIComponent(container)}/stop?t=${timeout}`, { method: 'POST' });
  }

  async restart(container, { timeout = 10 } = {}) {
    await this.request(`/containers/${encodeURIComponent(container)}/restart?t=${timeout}`, { method: 'POST' });
  }

  async stats(container) {
    const raw = await this.request(`/containers/${encodeURIComponent(container)}/stats?stream=false`);
    if (!raw || !raw.cpu_stats) return null;

    const cpuDelta = raw.cpu_stats.cpu_usage.total_usage - raw.precpu_stats.cpu_usage.total_usage;
    const systemDelta = raw.cpu_stats.system_cpu_usage - raw.precpu_stats.system_cpu_usage;
    const cores = raw.cpu_stats.online_cpus || 1;
    const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * cores * 100 : 0;

    return {
      cpu: Math.round(cpuPercent * 10) / 10,
      mem: Math.round((raw.memory_stats.usage || 0) / (1024 * 1024) * 10) / 10,
      memPercent:
        raw.memory_stats.limit > 0
          ? Math.round((raw.memory_stats.usage / raw.memory_stats.limit) * 1000) / 10
          : 0,
    };
  }

  /**
   * Stream de logs. O Docker responde com chunked encoding e, dentro de
   * cada chunk, frames multiplexados: 8 bytes de cabecalho (tipo do stream
   * + tamanho) seguidos do conteudo.
   */
  streamLogs(container, { tail = 200 } = {}) {
    const stream = new EventEmitter();
    let socket;

    stream.stop = () => {
      try {
        socket?.destroy();
      } catch {
        /* ja fechado */
      }
    };

    this.connect()
      .then(() => {
        socket = net.connect(this.pipe);
        let raw = Buffer.alloc(0);
        let chunked = true;
        let headerDone = false;
        let frames = Buffer.alloc(0);

        socket.on('connect', () => {
          socket.write(
            `GET /${API_VERSION}/containers/${encodeURIComponent(container)}/logs?stdout=1&stderr=1&follow=1&tail=${tail} HTTP/1.1\r\n` +
              'Host: docker\r\nAccept: application/octet-stream\r\n\r\n'
          );
        });

        socket.on('data', (chunk) => {
          raw = Buffer.concat([raw, chunk]);

          if (!headerDone) {
            const headerEnd = raw.indexOf('\r\n\r\n');
            if (headerEnd === -1) return;
            const headers = raw.slice(0, headerEnd).toString('utf8');
            chunked = /transfer-encoding:\s*chunked/i.test(headers);
            raw = raw.slice(headerEnd + 4);
            headerDone = true;
          }

          if (chunked) {
            // Chunked: <tamanho hex>\r\n<dados>\r\n
            for (;;) {
              const lineEnd = raw.indexOf('\r\n');
              if (lineEnd === -1) break;
              const size = parseInt(raw.slice(0, lineEnd).toString('utf8'), 16);
              if (!Number.isFinite(size)) break;
              if (size === 0) {
                raw = Buffer.alloc(0);
                break;
              }
              const start = lineEnd + 2;
              if (raw.length < start + size) break;
              frames = Buffer.concat([frames, raw.slice(start, start + size)]);
              raw = raw.slice(start + size + 2);
            }
          } else {
            frames = Buffer.concat([frames, raw]);
            raw = Buffer.alloc(0);
          }

          // Frames multiplexados: [tipo(1), 0,0,0, tamanho(4 big-endian)]
          while (frames.length >= 8) {
            const type = frames[0];
            const size = frames.readUInt32BE(4);
            if (frames.length < 8 + size) break;
            const payload = frames.slice(8, 8 + size).toString('utf8');
            frames = frames.slice(8 + size);
            if (payload) stream.emit('line', type === 2 ? 'stderr' : 'stdout', payload);
          }
        });

        socket.on('error', (err) => stream.emit('error', err));
        socket.on('close', () => stream.emit('close'));
      })
      .catch((err) => stream.emit('error', err));

    return stream;
  }
}

/** Decodifica o corpo chunked do Docker. */
function decodeChunked(buffer) {
  const out = [];
  let offset = 0;

  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd === -1) break;
    const size = parseInt(buffer.slice(offset, lineEnd).toString('utf8'), 16);
    if (!Number.isFinite(size)) break;
    if (size === 0) break;
    const start = lineEnd + 2;
    if (buffer.length < start + size) break;
    out.push(buffer.slice(start, start + size));
    offset = start + size + 2;
  }

  return out.length ? Buffer.concat(out) : null;
}

module.exports = { DockerApi };

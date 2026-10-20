'use strict';

const { execFile } = require('node:child_process');
const net = require('node:net');

/**
 * Descobre processos que ja estao escutando portas TCP na maquina,
 * para permitir monitorar/adotar servidores que foram iniciados fora do painel.
 */

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : stdout.toString());
    });
  });
}

async function listListeningPorts() {
  const rows = process.platform === 'win32' ? await listWindows() : await listPosix();
  return rows;
}

async function listWindows() {
  const out = await run('netstat', ['-ano', '-p', 'TCP']);
  const entries = [];

  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !/^TCP/i.test(trimmed)) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 5) continue;
    if (!/LISTENING/i.test(parts[parts.length - 2])) continue;

    const local = parts[1];
    const pid = Number(parts[parts.length - 1]);
    if (!pid) continue;

    const port = Number(local.slice(local.lastIndexOf(':') + 1));
    if (!port) continue;

    const host = local.slice(0, local.lastIndexOf(':')).replace(/^\[|\]$/g, '');
    entries.push({ pid, port, host, address: local });
  }

  const names = await processNames([...new Set(entries.map((e) => e.pid))]);

  // netstat lista a mesma porta em IPv4 e IPv6: mantem uma entrada por porta.
  const byPort = new Map();
  for (const entry of entries) {
    const existing = byPort.get(entry.port);
    if (!existing) {
      byPort.set(entry.port, entry);
      continue;
    }
    // Prefere a entrada cujo processo realmente responde a conexao.
    if (existing.pid === entry.pid) continue;
    byPort.set(entry.port, entry.pid !== 4 && existing.pid === 4 ? entry : existing);
  }

  return [...byPort.values()]
    .map((e) => ({ ...e, process: names.get(e.pid) || 'desconhecido' }))
    .sort((a, b) => a.port - b.port);
}

async function listPosix() {
  const out = await run('sh', ['-c', 'netstat -an 2>/dev/null || ss -ltn 2>/dev/null']);
  const entries = [];
  const seen = new Set();

  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const local = parts[3];
    if (!local || !local.includes('.')) continue;
    const port = Number(local.slice(local.lastIndexOf(':') + 1));
    if (!port || port < 1024) continue;
    const key = `${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ pid: 0, port, host: '0.0.0.0', address: local, process: 'desconhecido' });
  }
  return entries;
}

/**
 * Nome dos processos por PID, com cache.
 *
 * A busca de nomes e cara (tasklist sem filtro leva ~1,4s). Como a lista de
 * portas e estavel, guardar o nome por PID evita refazer a consulta a cada
 * varredura - e evita o custo de memoria de subir um interpretador.
 */
const nameCache = new Map(); // pid -> { name, at }
const NAME_CACHE_TTL = 120000;

async function processNames(pids) {
  const map = new Map();
  if (!pids.length) return map;

  const now = Date.now();
  const faltando = [];
  for (const pid of pids) {
    const cached = nameCache.get(pid);
    if (cached && now - cached.at < NAME_CACHE_TTL) {
      map.set(pid, cached.name);
    } else {
      faltando.push(pid);
    }
  }
  if (!faltando.length) return map;

  if (process.platform === 'win32') {
    // tasklist sem filtro e lento, mas traz todos os processos de uma vez.
    const out = await run('tasklist.exe', ['/FO', 'CSV', '/NH']);
    const wanted = new Set(faltando);
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = line.split('","');
      if (parts.length < 2) continue;
      const name = parts[0].replace(/^"/, '');
      const pid = Number(parts[1].replace(/"/g, ''));
      if (pid && name && wanted.has(pid)) {
        map.set(pid, name);
        nameCache.set(pid, { name, at: now });
      }
    }
    return map;
  }

  const out = await run('ps', ['-o', 'pid=,comm=', '-p', faltando.join(',')]);
  for (const line of out.split(/\r?\n/)) {
    const [pid, ...rest] = line.trim().split(/\s+/);
    if (pid) {
      map.set(Number(pid), rest.join(' '));
      nameCache.set(Number(pid), { name: rest.join(' '), at: now });
    }
  }
  return map;
}

/** Testa se a porta TCP esta aceitando conexoes localmente. */
function isPortOpen(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeout);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

module.exports = { listListeningPorts, isPortOpen, findPortOwner };

/* ------------------------------------------------------------------ */
/* Dono da porta                                                        */
/* ------------------------------------------------------------------ */

let ownerCache = { at: 0, rows: [] };

/**
 * Descobre qual processo esta escutando uma porta.
 * O resultado e cacheado por alguns segundos, porque a varredura completa
 * (netstat + consulta de nomes) custa mais que um health check.
 */
async function findPortOwner(port) {
  if (Date.now() - ownerCache.at > 5000) {
    try {
      ownerCache = { at: Date.now(), rows: await listListeningPorts() };
    } catch {
      ownerCache = { at: Date.now(), rows: [] };
    }
  }
  return ownerCache.rows.find((row) => row.port === port) ?? null;
}

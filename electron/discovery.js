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

async function processNames(pids) {
  const map = new Map();
  if (!pids.length) return map;

  if (process.platform === 'win32') {
    const out = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-Process -Id @(${pids.join(',')}) -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$($_.ProcessName)" }`,
    ]);
    for (const line of out.split(/\r?\n/)) {
      const [pid, name] = line.trim().split('|');
      if (pid && name) map.set(Number(pid), name);
    }
  } else {
    const out = await run('ps', ['-o', 'pid=,comm=', '-p', pids.join(',')]);
    for (const line of out.split(/\r?\n/)) {
      const [pid, ...rest] = line.trim().split(/\s+/);
      if (pid) map.set(Number(pid), rest.join(' '));
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

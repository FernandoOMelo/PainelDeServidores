'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const versionCache = new Map();

/** Comandos que passam a apontar para o node customizado. */
const ALIASES = {
  node: 'node.exe',
  'node.exe': 'node.exe',
  npm: 'npm.cmd',
  'npm.cmd': 'npm.cmd',
  npx: 'npx.cmd',
  'npx.cmd': 'npx.cmd',
};

/**
 * Descobre o node.exe a usar.
 * Aceita o caminho do proprio executavel ou a pasta que o contem.
 */
function resolveNodeExecutable(configured, appRoot) {
  const raw = String(configured || '').trim();
  if (!raw) return null;

  const target = path.isAbsolute(raw) ? raw : path.resolve(appRoot, raw);

  try {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      const inside = path.join(target, 'node.exe');
      return fs.existsSync(inside) ? inside : null;
    }
    if (stat.isFile()) return target;
  } catch {
    return null;
  }
  return null;
}

/**
 * Monta comando, argumentos e ambiente de execucao de um servico.
 *
 * Quando o servico define um node customizado:
 *  - a pasta do node entra no PATH, para que npm/npx e os processos filhos
 *    usem a mesma versao (essencial com nvm-windows e node embutido no
 *    projeto);
 *  - comandos "node"/"npm"/"npx" passam a ser resolvidos pelo caminho
 *    absoluto dentro daquela pasta.
 */
function resolveExecution(service, appRoot) {
  const result = {
    command: service.command,
    args: Array.isArray(service.args) ? [...service.args] : [],
    env: {},
    nodePath: null,
    nodeDir: null,
    warning: null,
  };

  const configured = String(service.nodePath || '').trim();
  if (!configured) return result;

  const nodeExe = resolveNodeExecutable(configured, appRoot);
  if (!nodeExe) {
    result.warning = `Node customizado nao encontrado: ${configured}`;
    return result;
  }

  result.nodePath = nodeExe;
  result.nodeDir = path.dirname(nodeExe);

  const currentPath = process.env.PATH || '';
  result.env.PATH = currentPath
    ? `${result.nodeDir}${path.delimiter}${currentPath}`
    : result.nodeDir;

  // No Windows o Node tambem consulta PATHEXT; com shell=false o spawn usa
  // o caminho absoluto, entao reescrever o comando e suficiente.
  const base = path.basename(service.command || '').toLowerCase();
  const target = ALIASES[base];
  if (target) {
    const candidate = path.join(result.nodeDir, target);
    if (fs.existsSync(candidate)) {
      result.command = candidate;
    } else {
      result.warning = `"${base}" nao encontrado em ${result.nodeDir}; usando o PATH do sistema.`;
    }
  }

  return result;
}

/** Executa `<node> --version` e devolve a string de versao (ex.: v18.20.8). */
function detectNodeVersion(nodePath) {
  if (!nodePath) return Promise.resolve(null);
  if (versionCache.has(nodePath)) return Promise.resolve(versionCache.get(nodePath));

  return new Promise((resolve) => {
    execFile(nodePath, ['--version'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) {
        versionCache.set(nodePath, null);
        resolve(null);
        return;
      }
      const version = stdout.toString().trim() || null;
      versionCache.set(nodePath, version);
      resolve(version);
    });
  });
}

/** Versao do node global em uso (PATH do sistema). */
function detectSystemNodeVersion() {
  return detectNodeVersion(process.execPath);
}

/**
 * Procura um node "embutido" dentro da pasta de um projeto.
 * Cobre os formatos mais comuns de distribuicao portavel (node/node.exe,
 * nodejs/bin/node.exe, runtime/node/node.exe...) e faz uma varredura rasa
 * de subpastas, que e onde costuma ficar.
 */
function findEmbeddedNodes(cwd) {
  const found = [];
  const seen = new Set();

  const consider = (exe) => {
    if (!exe) return;
    const key = path.resolve(exe).toLowerCase();
    if (seen.has(key)) return;
    try {
      if (!fs.statSync(exe).isFile()) return;
    } catch {
      return;
    }
    seen.add(key);
    found.push(exe);
  };

  const root = path.resolve(cwd || '.');
  consider(path.join(root, 'node.exe'));

  for (const dir of EMBEDDED_NODE_DIRS) {
    consider(path.join(root, dir, 'node.exe'));
  }

  // Varredura rasa das subpastas imediatas do projeto.
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(root, entry.name);
      consider(path.join(sub, 'node.exe'));
      consider(path.join(sub, 'node', 'node.exe'));
      consider(path.join(sub, 'nodejs', 'node.exe'));
      consider(path.join(sub, 'bin', 'node.exe'));
      consider(path.join(sub, 'runtime', 'node', 'node.exe'));
    }
  } catch {
    /* pasta inacessivel */
  }

  return found;
}

/** Pasta onde ficam os node.exe embarcados em projetos. */
const EMBEDDED_NODE_DIRS = [
  'node',
  'nodejs',
  '.node',
  'node-runtime',
  'nodejs/bin',
  'node/bin',
  'vendor/node',
  'vendor/nodejs',
  'runtime/node',
  'runtime/nodejs',
  'runtime/.node',
  'bin',
];

module.exports = {
  resolveExecution,
  resolveNodeExecutable,
  detectNodeVersion,
  detectSystemNodeVersion,
  findEmbeddedNodes,
};

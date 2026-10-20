/** Utilitarios compartilhados da interface. */

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function formatUptime(ms) {
  if (!ms || ms < 0) return '--';
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatClock(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Divide uma string de argumentos respeitando aspas duplas e simples. */
export function splitArgs(input) {
  const args = [];
  let current = '';
  let quote = null;
  let hasContent = false;

  for (const char of String(input || '')) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      hasContent = true;
    } else if (/\s/.test(char)) {
      if (current || hasContent) {
        args.push(current);
        current = '';
        hasContent = false;
      }
    } else {
      current += char;
      hasContent = true;
    }
  }
  if (current || hasContent) args.push(current);
  return args;
}

/** Converte o texto "KEY=VALUE" (uma por linha) em objeto. */
export function parseEnv(text) {
  const env = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return env;
}

export function stringifyEnv(env) {
  return Object.entries(env || {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

export const STATE_LABELS = {
  stopped: 'Parado',
  starting: 'Iniciando',
  running: 'Rodando',
  stopping: 'Parando',
  backoff: 'Reiniciando',
  crashed: 'Erro',
  paused: 'Pausado',
};

export const HEALTH_LABELS = {
  unknown: 'sem verificacao',
  healthy: 'saudavel',
  unhealthy: 'fora do ar',
};

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Persistencia em JSON no arquivo de configuracao local do projeto.
 * Escrita atomica (arquivo temporario + rename) para evitar corrupcao
 * caso o app seja fechado no meio de um save.
 */
class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = this.#read();
  }

  #read() {
    const defaults = {
      version: 1,
      settings: {
        logBufferLines: 2000,
        metricsIntervalMs: 2000,
        autoStart: true,
      },
      services: [],
    };

    try {
      if (!fs.existsSync(this.filePath)) return defaults;
      const raw = fs.readFileSync(this.filePath, 'utf8').trim();
      if (!raw) return defaults;
      const parsed = JSON.parse(raw);
      return {
        ...defaults,
        ...parsed,
        settings: { ...defaults.settings, ...(parsed.settings || {}) },
        services: Array.isArray(parsed.services) ? parsed.services : [],
      };
    } catch (err) {
      // Arquivo corrompido: preserva o original para inspecao e comeca limpo.
      try {
        const backup = `${this.filePath}.corrompido-${Date.now()}`;
        fs.copyFileSync(this.filePath, backup);
        console.error(`[store] config invalida, backup em ${backup}:`, err.message);
      } catch {
        console.error('[store] falha ao salvar backup da config invalida:', err.message);
      }
      return defaults;
    }
  }

  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  get settings() {
    return this.data.settings;
  }

  get services() {
    return this.data.services;
  }

  setServices(services) {
    this.data.services = services;
    this.save();
  }

  setSetting(key, value) {
    this.data.settings[key] = value;
    this.save();
  }

  getSetting(key, fallback) {
    return this.data.settings[key] ?? fallback;
  }
}

const DEFAULT_HEALTH = {
  type: 'none', // 'none' | 'tcp' | 'http'
  port: null,
  path: '/',
  expectStatus: 200,
  intervalMs: 5000,
  timeoutMs: 3000,
  graceMs: 10000,
  failuresBeforeUnhealthy: 3,
};

const DEFAULT_RESTART = {
  enabled: true,
  maxRetries: 5,
  backoffMs: 1000,
  maxBackoffMs: 30000,
  restartOnUnhealthy: true,
  stabilityMs: 60000,
};

/** Normaliza um servico vindo da UI, preenchendo defaults e saneando tipos. */
function normalizeService(input) {
  const id = input.id || crypto.randomUUID();
  const name = String(input.name || '').trim() || 'Servidor sem nome';
  const command = String(input.command || '').trim();
  const cwd = String(input.cwd || '').trim();

  const type = ['processo', 'docker', 'servico'].includes(input.type) ? input.type : 'processo';

  const health = { ...DEFAULT_HEALTH, ...(input.health || {}) };
  health.type = ['none', 'tcp', 'http'].includes(health.type) ? health.type : 'none';
  health.port = health.port ? Number(health.port) : null;
  health.path = String(health.path || '/');
  health.expectStatus = Number(health.expectStatus) || 200;
  health.intervalMs = Math.max(1000, Number(health.intervalMs) || 5000);
  health.timeoutMs = Math.max(500, Number(health.timeoutMs) || 3000);
  health.graceMs = Math.max(0, Number(health.graceMs) || 0);
  health.failuresBeforeUnhealthy = Math.max(1, Number(health.failuresBeforeUnhealthy) || 3);

  const restart = { ...DEFAULT_RESTART, ...(input.restart || {}) };
  restart.enabled = Boolean(restart.enabled);
  restart.maxRetries = Math.max(0, Number(restart.maxRetries) || 0);
  restart.backoffMs = Math.max(100, Number(restart.backoffMs) || 1000);
  restart.maxBackoffMs = Math.max(restart.backoffMs, Number(restart.maxBackoffMs) || 30000);
  restart.restartOnUnhealthy = Boolean(restart.restartOnUnhealthy);
  restart.stabilityMs = Math.max(5000, Number(restart.stabilityMs) || 60000);

  const env = {};
  for (const [key, value] of Object.entries(input.env || {})) {
    if (key) env[String(key)] = String(value);
  }

  return {
    id,
    name,
    group: String(input.group || '').trim() || 'Geral',
    type,
    command,
    args: Array.isArray(input.args)
      ? input.args.map(String).filter((a) => a !== '')
      : String(input.args || '')
          .split(/\s+/)
          .filter(Boolean),
    // Guardado como digitado: caminho relativo e resolvido contra a pasta do app
    // em tempo de execucao, o que mantem o config portavel entre maquinas.
    cwd,
    env,
    shell: Boolean(input.shell),
    autostart: Boolean(input.autostart),
    monitorOnly: Boolean(input.monitorOnly),
    // Node proprio do servico: caminho do node.exe (ou da pasta que o contem).
    // A pasta entra no PATH do processo, entao npm/npx e os filhos usam a
    // mesma versao - permite rodar varias versoes em paralelo.
    nodePath: String(input.nodePath || '').trim(),
    // Container alvo quando type = 'docker'.
    container: String(input.container || '').trim(),
    // Nome do servico do Windows quando type = 'servico'.
    service: String(input.service || '').trim(),
    health,
    restart,
    createdAt: input.createdAt || new Date().toISOString(),
  };
}

module.exports = { Store, normalizeService, DEFAULT_HEALTH, DEFAULT_RESTART };

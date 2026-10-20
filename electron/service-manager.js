'use strict';

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ServiceRunner, STATES } = require('./service-runner');
const { DockerRunner } = require('./docker-runner');
const { DockerClient } = require('./docker');
const { HealthMonitor } = require('./health-checker');
const { MetricsCollector } = require('./metrics');
const { normalizeService } = require('./store');
const { detectNodeVersion, resolveNodeExecutable } = require('./executables');

/**
 * Orquestrador: mantem os servicos registrados, Their runners, monitores
 * de saude e a coleta de metricas, emitindo eventos consumidos pela UI.
 */
class ServiceManager extends EventEmitter {
  constructor(store, options = {}) {
    super();
    this.store = store;
    this.appRoot = options.appRoot || process.cwd();
    this.logDir = options.logDir || path.join(this.appRoot, 'logs');
    this.runners = new Map(); // id -> ServiceRunner | DockerRunner
    this.monitors = new Map(); // id -> HealthMonitor
    this.docker = new DockerClient({ binary: options.dockerBinary });
    this.metrics = new MetricsCollector({
      intervalMs: store.getSetting('metricsIntervalMs', 2000),
      dir: options.tempDir,
    });

    this.metrics.on('metrics', (payload) => this.emit('metrics', payload));
  }

  get services() {
    return this.store.services;
  }

  init() {
    // Idempotente: nao recria runners que ja existem (evita eventos duplicados).
    for (const service of this.services) {
      if (!this.runners.has(service.id)) this.#attach(service);
    }

    this.metrics.start();
    this.#syncPids();

    for (const service of this.services) {
      if (service.monitorOnly) this.observe(service.id);
      else if (service.autostart) this.start(service.id);
    }

    this.emit('services-changed', this.list());

    // Containers so podem ser monitorados se o daemon estiver de pe.
    if (this.services.some((s) => s.type === 'docker')) {
      this.docker.availability().then((status) => {
        if (!status.ok) {
          this.emit('notice', {
            level: 'error',
            title: 'Docker indisponivel',
            message: status.error,
          });
        }
      });
    }
  }

  #attach(service) {
    const maxLogs = this.store.getSetting('logBufferLines', 2000);
    const runner =
      service.type === 'docker'
        ? new DockerRunner(service, { docker: this.docker, maxLogs, logDir: this.logDir })
        : new ServiceRunner(service, { maxLogs, logDir: this.logDir, appRoot: this.appRoot });

    runner.setOptions?.({ maxLogs, logDir: this.logDir, appRoot: this.appRoot });

    runner.on('state', (snapshot) => this.#onState(service.id, snapshot));
    runner.on('log', (entries) => {
      if (entries.length) this.emit('log', { id: service.id, entries });
    });
    runner.on('metrics', (payload) => this.emit('metrics', payload));
    runner.on('health', (payload) => this.emit('health', { id: service.id, ...payload }));
    runner.on('restart-exhausted', ({ reason }) => {
      this.emit('notice', {
        level: 'error',
        title: service.name,
        message: `Reinicio automatico esgotado: ${reason}`,
      });
    });

    // Containers tem health proprio (HEALTHCHECK do docker); o monitor TCP/HTTP
    // so se aplica a servicos de processo.
    let monitor = null;
    if (service.type !== 'docker') {
      monitor = new HealthMonitor(service);
      monitor.on('result', (result) => {
        this.emit('health', { id: service.id, ...result });
      });
      monitor.on('unhealthy', (result) => {
        this.emit('notice', {
          level: 'error',
          title: service.name,
          message: `Health check falhou: ${result.error || 'sem resposta'}`,
        });
        const runnerRef = this.runners.get(service.id);
        const cfg = service.restart || {};
        if (cfg.restartOnUnhealthy && runnerRef && runnerRef.isActive) {
          runnerRef.restartCount = 0;
          runnerRef.restart();
        }
      });
      monitor.on('recovered', () => {
        this.emit('notice', { level: 'success', title: service.name, message: 'Health check recuperado.' });
      });
    }

    this.runners.set(service.id, runner);
    if (monitor) this.monitors.set(service.id, monitor);

    // Detecta a versao do node do servico logo no cadastro, para que o painel
    // mostre qual versao cada servico usa mesmo antes de roda-lo.
    if (service.type !== 'docker' && service.nodePath) {
      this.detectNodeVersion(service.nodePath).then((version) => {
        runner.nodeVersion = version;
        this.emit('state', runner.snapshot());
      });
    }

    return runner;
  }

  #onState(id, snapshot) {
    const service = this.services.find((s) => s.id === id);
    const isDocker = service?.type === 'docker';

    if (!isDocker && service?.health?.type !== 'none' && service?.health?.port) {
      const monitor = this.monitors.get(id);
      if (snapshot.state === STATES.RUNNING) {
        monitor?.start();
        if (service.health.graceMs > 0) {
          setTimeout(() => monitor?.check().catch(() => {}), service.health.graceMs).unref?.();
        } else {
          monitor?.check().catch(() => {});
        }
      } else {
        monitor?.stop();
        monitor?.reset();
        // Informa a UI que nao ha mais verificacao em andamento.
        this.emit('health', { id, ok: false, state: 'unknown', latencyMs: 0 });
      }
    }

    this.#syncPids();
    this.emit('state', snapshot);
  }

  #syncPids() {
    const entries = [];
    for (const [id, runner] of this.runners) {
      if (runner.pid) entries.push([id, runner.pid]);
    }
    this.metrics.setPids(entries);
  }

  getState() {
    const states = {};
    for (const [id, runner] of this.runners) {
      const monitor = this.monitors.get(id);
      const snapshot = runner.snapshot();
      states[id] = {
        ...snapshot,
        health: snapshot.health ?? monitor?.state ?? 'unknown',
        healthDetail: snapshot.healthDetail ?? monitor?.lastResult ?? null,
      };
    }
    return states;
  }

  list() {
    return this.services.map((service) => ({
      ...service,
      state: this.getState()[service.id] ?? null,
    }));
  }

  getService(id) {
    return this.services.find((s) => s.id === id) ?? null;
  }

  create(input) {
    const service = normalizeService(input);
    if (service.type === 'docker' && !service.container) {
      throw new Error('Informe o nome do container Docker.');
    }
    this.store.setServices([...this.services, service]);
    this.#attach(service);
    // Servico somente monitorar precisa comecar a acompanhar imediatamente,
    // mesmo tendo sido criado depois do init().
    if (service.monitorOnly) this.observe(service.id);
    this.emit('services-changed', this.list());
    return service;
  }

  update(id, input) {
    const index = this.services.findIndex((s) => s.id === id);
    if (index === -1) throw new Error('Servico nao encontrado.');

    const current = this.services[index];
    const service = normalizeService({ ...current, ...input, id });
    if (service.type === 'docker' && !service.container) {
      throw new Error('Informe o nome do container Docker.');
    }

    this.store.setServices(this.services.map((s, i) => (i === index ? service : s)));

    const runner = this.runners.get(id);
    if (runner) {
      const wasRunning = runner.isActive;
      runner.service = service;
      runner.intentionalStop = true;
      runner.dispose();
      this.runners.delete(id);
      this.monitors.get(id)?.stop();
      this.monitors.delete(id);

      const fresh = this.#attach(service);
      if (service.monitorOnly) this.observe(id);
      else if (wasRunning) fresh.start();
    }

    this.emit('services-changed', this.list());
    return service;
  }

  remove(id) {
    const runner = this.runners.get(id);
    if (runner) {
      runner.dispose();
      this.runners.delete(id);
    }
    this.monitors.get(id)?.stop();
    this.monitors.delete(id);

    this.store.setServices(this.services.filter((s) => s.id !== id));
    this.#syncPids();
    this.emit('services-changed', this.list());
  }

  start(id) {
    const service = this.getService(id);
    const runner = this.runners.get(id);
    if (!runner) return;
    if (service?.monitorOnly) return;
    if (runner.isActive) return;
    runner.start();
  }

  async stop(id) {
    const service = this.getService(id);
    const runner = this.runners.get(id);
    if (!runner) return;
    if (service?.monitorOnly) return;
    await runner.stop();
  }

  async restart(id) {
    const service = this.getService(id);
    const runner = this.runners.get(id);
    if (!runner) return;
    if (service?.monitorOnly) return;
    await runner.restart();
  }

  /**
   * Acompanha um servico sem controla-lo. Para containers, o runner le o
   * estado real; para processos externos, o acompanhamento fica a cargo do
   * health check de porta.
   */
  observe(id) {
    const service = this.getService(id);
    const runner = this.runners.get(id);
    if (!runner) return;

    runner.observe?.();

    const monitor = this.monitors.get(id);
    if (monitor && service?.health?.type !== 'none' && service?.health?.port) {
      monitor.start();
      monitor.check().catch(() => {});
    }
  }

  startAll() {
    for (const service of this.services) {
      if (!service.monitorOnly) this.start(service.id);
    }
  }

  async stopAll() {
    for (const service of this.services) {
      await this.stop(service.id);
    }
  }

  getLogs(id) {
    return this.runners.get(id)?.getLogs() ?? [];
  }

  clearLogs(id) {
    this.runners.get(id)?.clearLogs();
  }

  /** Containers disponiveis na maquina, prontos para cadastro. */
  async listContainers() {
    const status = await this.docker.availability();
    if (!status.ok) throw new Error(status.error);
    return this.docker.listContainers();
  }

  /** Versao do node em um caminho especifico (null quando invalido). */
  async detectNodeVersion(nodePath) {
    const resolved = resolveNodeExecutable(nodePath, this.appRoot);
    if (!resolved) return null;
    return detectNodeVersion(resolved);
  }

  dispose() {
    for (const runner of this.runners.values()) runner.dispose();
    for (const monitor of this.monitors.values()) monitor.stop();
    this.metrics.stop();
  }
}

module.exports = { ServiceManager, STATES };

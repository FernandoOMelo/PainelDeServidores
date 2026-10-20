'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { ServiceRunner, STATES } = require('./service-runner');
const { DockerRunner } = require('./docker-runner');
const { DockerClient } = require('./docker');
const { WindowsServiceRunner } = require('./windows-service-runner');
const { WindowsServiceClient } = require('./windows-service');
const { HealthMonitor } = require('./health-checker');
const { MetricsCollector } = require('./metrics');
const { normalizeService } = require('./store');
const { detectNodeVersion, resolveNodeExecutable, findEmbeddedNodes } = require('./executables');

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
    this.lastState = new Map(); // id -> ultimo estado conhecido
    this.docker = new DockerClient({ binary: options.dockerBinary });
    this.windowsServices = new WindowsServiceClient({ scBinary: options.scBinary });
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

  /** Servicos do Windows disponiveis para cadastro. */
  async listWindowsServices() {
    return this.windowsServices.list();
  }

  #attach(service) {
    const maxLogs = this.store.getSetting('logBufferLines', 2000);
    let runner;

    if (service.type === 'docker') {
      runner = new DockerRunner(service, { docker: this.docker, maxLogs, logDir: this.logDir });
    } else if (service.type === 'servico') {
      runner = new WindowsServiceRunner(service, {
        client: this.windowsServices,
        // Quando ha health check HTTP/TCP, ele manda no status de saude;
        // senao a saude vem do proprio estado do servico no Windows.
        healthFromService: service.health?.type === 'none',
      });
    } else {
      runner = new ServiceRunner(service, { maxLogs, logDir: this.logDir, appRoot: this.appRoot });
    }

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
    runner.on('notice', (payload) => {
      this.emit('notice', { title: service.name, ...payload });
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
    if (service.type !== 'docker' && service.type !== 'servico' && service.nodePath) {
      this.detectNodeVersion(service.nodePath).then((version) => {
        runner.nodeVersion = version;
        this.emit('state', runner.snapshot());
      });
    }

    // Containers e servicos do Windows sao sempre acompanhados: podem ter
    // sido iniciados por fora do painel, e o estado real precisa aparecer.
    if (service.type === 'docker' || service.type === 'servico') {
      if (service.monitorOnly) runner.observe();
      else runner.monitor();
    }

    return runner;
  }

  #onState(id, snapshot) {
    const service = this.services.find((s) => s.id === id);
    const isDocker = service?.type === 'docker';

    // O monitor so muda de estado nas TRANSICOES. Sem isso, cada poll
    // reiniciaria o timer do health check e reagendaria a espera inicial,
    // e a verificacao nunca chegaria a rodar.
    const previous = this.lastState.get(id);
    this.lastState.set(id, snapshot.state);

    if (!isDocker && service?.health?.type !== 'none' && service?.health?.port) {
      const monitor = this.monitors.get(id);

      if (snapshot.state === STATES.RUNNING) {
        if (previous !== STATES.RUNNING) {
          monitor?.start();
          if (service.health.graceMs > 0) {
            setTimeout(() => monitor?.check().catch(() => {}), service.health.graceMs).unref?.();
          } else {
            monitor?.check().catch(() => {});
          }
        }
      } else if (previous === STATES.RUNNING) {
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
      // Servicos do Windows tambem tem PID proprio, entao entram na
      // coleta de CPU/memoria sem precisar controlar o processo.
      if (runner.pid) entries.push([id, runner.pid]);
    }
    this.metrics.setPids(entries);
  }

  getState() {
    const states = {};
    for (const [id, runner] of this.runners) {
      const monitor = this.monitors.get(id);
      const service = this.services.find((s) => s.id === id);
      const snapshot = runner.snapshot();

      // Com health check configurado, quem manda no status de saude e o
      // monitor (HTTP/TCP). Sem ele, vale o status que o proprio runner
      // derivou (estado do container, estado do servico do Windows).
      const hasCheck = service?.health?.type && service.health.type !== 'none';

      states[id] = {
        ...snapshot,
        health: hasCheck ? monitor?.state ?? 'unknown' : snapshot.health ?? 'unknown',
        healthDetail: hasCheck ? monitor?.lastResult ?? null : snapshot.healthDetail ?? null,
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
    if (service.type === 'servico' && !service.service) {
      throw new Error('Selecione o servico do Windows.');
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
    if (service.type === 'servico' && !service.service) {
      throw new Error('Selecione o servico do Windows.');
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
      this.lastState.delete(id);

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
    this.lastState.delete(id);

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

  /**
   * Procura node embarcado na pasta do servico, para o cadastro nao exigir
   * que o caminho do node.exe seja digitado a mao.
   */
  async discoverNodes(cwd) {
    const root = cwd ? path.resolve(this.appRoot, cwd) : this.appRoot;
    const candidates = findEmbeddedNodes(root);

    const results = [];
    for (const exe of candidates) {
      const version = await detectNodeVersion(exe);
      results.push({
        path: exe,
        version,
        npm: fs.existsSync(path.join(path.dirname(exe), 'npm.cmd')),
      });
    }
    return results;
  }

  dispose() {
    for (const runner of this.runners.values()) runner.dispose();
    for (const monitor of this.monitors.values()) monitor.stop();
    this.metrics.stop();
  }
}

module.exports = { ServiceManager, STATES };

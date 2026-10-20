import { el, clear, formatUptime, STATE_LABELS, HEALTH_LABELS, statusOf } from './util.js';
import { openServiceForm } from './service-form.js';
import { openDiscovery } from './discovery.js';
import { LogPanel } from './log-panel.js';
import { Dashboard } from './dashboard.js';
import { confirmDialog, closeModal } from './modal.js';
import { toast } from './toast.js';

const api = window.api;

/** Baldes de status: a mesma classificacao vale para o filtro e para os contadores. */
const STATUS_BUCKETS = [
  { key: 'running', label: 'rodando', color: 'var(--ok)' },
  { key: 'stopped', label: 'parados', color: 'var(--idle)' },
  { key: 'down', label: 'fora do ar', color: 'var(--danger)' },
  { key: 'problem', label: 'com problema', color: 'var(--warn)' },
];

const state = {
  services: [],
  runtime: {},
  selectedId: null,
  filter: '',
  group: 'all',
  status: 'all',
  onlyRunning: false,
};

const cards = new Map(); // id -> { node, refs }
let logPanel = null;
let dashboard = null;

/* ------------------------------------------------------------------ */
/* Infraestrutura de render                                             */
/* ------------------------------------------------------------------ */

const grid = document.getElementById('services-grid');
const emptyState = document.getElementById('empty-state');
const groupFilter = document.getElementById('group-filter');
const statsNode = document.getElementById('stats');
const searchInput = document.getElementById('search');
const onlyRunningInput = document.getElementById('only-running');

function visibleServices() {
  const term = state.filter.toLowerCase();
  return state.services.filter((service) => {
    if (state.group !== 'all' && service.group !== state.group) return false;
    if (state.status !== 'all') {
      if (statusOf(state.runtime[service.id]) !== state.status) return false;
    }
    if (state.onlyRunning) {
      const runtime = state.runtime[service.id];
      if (!runtime || !['running', 'starting'].includes(runtime.state)) return false;
    }
    if (!term) return true;
    const haystack = `${service.name} ${service.group} ${service.command} ${(service.args || []).join(' ')}`;
    return haystack.toLowerCase().includes(term);
  });
}

function createCard(service) {
  const dot = el('span', { class: 'dot' });
  const name = el('h3', { text: service.name, title: service.name });
  const groupTag = el('span', { class: 'tag', text: service.group });
  const runtimeTag = el('span', { class: 'tag tag-accent' });
  const readonlyTag = el('span', { class: 'tag tag-warn', text: 'somente leitura' });
  readonlyTag.hidden = !service.monitorOnly;
  const badge = el('span', { class: 'badge stopped', text: 'Parado' });
  const cmd = el('div', { class: 'cmd' });
  const portValue = el('dd', { text: '--' });
  const pidLabel = el('dt', { text: 'PID' });
  const pidValue = el('dd', { text: '--' });
  const cpuValue = el('dd', { text: '--' });
  const memValue = el('dd', { text: '--' });
  const healthDot = el('span', { class: 'health-dot' });
  const healthText = el('span', { text: 'sem verificacao' });

  const startBtn = el('button', { class: 'btn btn-ok', text: 'Iniciar' });
  const stopBtn = el('button', { class: 'btn btn-danger', text: 'Parar' });
  const restartBtn = el('button', { class: 'btn btn-ghost', text: 'Reiniciar' });
  const logsBtn = el('button', { class: 'btn btn-ghost', text: 'Logs' });
  const editBtn = el('button', { class: 'btn btn-ghost', text: 'Editar' });

  const node = el('article', { class: 'card', dataset: { id: service.id } }, [
    el('div', { class: 'card-head' }, [
      dot,
      el('div', { class: 'card-title' }, [
        name,
        el('div', { class: 'card-sub' }, [groupTag, runtimeTag, readonlyTag]),
      ]),
      badge,
    ]),
    cmd,
    el('dl', { class: 'meta' }, [
      el('div', {}, [el('dt', { text: 'Porta' }), portValue]),
      el('div', {}, [pidLabel, pidValue]),
      el('div', {}, [el('dt', { text: 'CPU' }), cpuValue]),
      el('div', {}, [el('dt', { text: 'Memoria' }), memValue]),
    ]),
    el('div', { class: 'health-line' }, [healthDot, healthText]),
    el('div', { class: 'card-actions' }, [
      startBtn,
      stopBtn,
      restartBtn,
      el('span', { class: 'spacer' }),
      logsBtn,
      editBtn,
    ]),
  ]);

  node.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    selectService(service.id, { toggle: true });
  });

  startBtn.addEventListener('click', () => api.services.start(service.id).catch(reportError));
  stopBtn.addEventListener('click', () => api.services.stop(service.id).catch(reportError));
  restartBtn.addEventListener('click', () => api.services.restart(service.id).catch(reportError));
  logsBtn.addEventListener('click', () => selectService(service.id));
  editBtn.addEventListener('click', () => openEdit(service.id));

  const refs = {
    node,
    dot,
    badge,
    cmd,
    runtimeTag,
    portValue,
    pidLabel,
    pidValue,
    cpuValue,
    memValue,
    healthDot,
    healthText,
    startBtn,
    stopBtn,
    restartBtn,
  };
  cards.set(service.id, refs);
  return refs;
}

function paintCard(service) {
  const refs = cards.get(service.id);
  if (!refs) return;

  const runtime = state.runtime[service.id] || { state: 'stopped' };
  const status = runtime.state || 'stopped';
  const isDocker = service.type === 'docker';
  const isService = service.type === 'servico';

  refs.node.dataset.status = status;
  refs.node.classList.toggle('selected', state.selectedId === service.id);
  refs.dot.className = `dot ${status}`;
  refs.badge.className = `badge ${status}`;
  refs.badge.textContent = STATE_LABELS[status] || status;

  if (isDocker) {
    refs.cmd.textContent = `container: ${service.container}`;
    refs.cmd.title = refs.cmd.textContent;
    refs.runtimeTag.textContent = runtime.image || 'docker';
    refs.runtimeTag.title = runtime.image || '';
    refs.pidLabel.textContent = 'Estado';
    refs.pidValue.textContent = runtime.containerState || '--';
    const published = (runtime.ports || [])
      .filter((p) => p.published)
      .map((p) => p.published)
      .join(', ');
    refs.portValue.textContent = published || '--';
  } else if (isService) {
    refs.cmd.textContent = `servico: ${service.service}`;
    refs.cmd.title = refs.cmd.title || runtime.path || refs.cmd.textContent;
    refs.runtimeTag.textContent = runtime.startMode || 'servico';
    refs.runtimeTag.title = runtime.path || '';
    refs.pidLabel.textContent = 'Estado';
    refs.pidValue.textContent = runtime.serviceState || '--';
    refs.portValue.textContent = service.health?.port ? service.health.port : '--';
  } else {
    const parts = [service.command, ...(service.args || [])].filter(Boolean);
    refs.cmd.textContent = parts.length ? parts.join(' ') : '(somente monitorar)';
    refs.cmd.title = refs.cmd.textContent;
    refs.runtimeTag.textContent = runtime.nodeVersion || (service.nodePath ? 'node?' : '');
    refs.runtimeTag.title = service.nodePath || '';
    refs.pidLabel.textContent = 'PID';
    refs.pidValue.textContent = runtime.pid ?? '--';
    refs.portValue.textContent = service.health?.port ? service.health.port : '--';
  }

  // Metricas so fazem sentido com o processo em execucao.
  const live = ['running', 'starting'].includes(status);
  refs.cpuValue.textContent = live && runtime.cpu !== undefined ? `${runtime.cpu}%` : '--';
  refs.memValue.textContent = live && runtime.mem !== undefined ? `${runtime.mem} MB` : '--';

  const health = runtime.health || 'unknown';
  const detail = runtime.healthDetail || {};
  const owner = detail.owner?.process;
  const latency = detail.latencyMs ? ` (${detail.latencyMs}ms)` : '';

  refs.healthDot.className = `health-dot ${health}`;

  if (isDocker) {
    refs.healthText.textContent = HEALTH_LABELS[health] || health;
  } else if (isService && service.health?.type === 'none') {
    // Sem health check, a saude vem do estado do servico no Windows.
    refs.healthText.textContent = HEALTH_LABELS[health] || health;
  } else if (service.health?.type === 'none') {
    refs.healthText.textContent = 'sem verificacao';
  } else {
    // Mostra quem responde na porta: evita o falso positivo de outra
    // aplicacao estar ocupando a mesma porta.
    const who = owner ? ` · ${owner}` : '';
    const label =
      health === 'unknown' ? 'verificando' : HEALTH_LABELS[health] || health;
    refs.healthText.textContent = `${label}${latency}${who}`;
    refs.healthText.title = detail.error
      ? `Ultimo erro: ${detail.error}`
      : owner
        ? `Responde na porta ${service.health.port}: ${detail.owner.process} (pid ${detail.owner.pid})`
        : '';
  }

  // Servico somente monitorar: o painel mostra o estado real, mas nao controla.
  const readOnly = Boolean(service.monitorOnly);
  if (readOnly && !isDocker) {
    const tone = health === 'healthy' ? 'running' : health === 'unhealthy' ? 'crashed' : 'stopped';
    refs.dot.className = `dot ${tone}`;
    refs.badge.className = `badge ${tone}`;
    refs.badge.textContent =
      health === 'healthy' ? 'Saudavel' : health === 'unhealthy' ? 'Fora do ar' : 'Monitorado';
  }

  const active = ['running', 'starting'].includes(status);
  const busy = ['starting', 'stopping', 'backoff'].includes(status);
  refs.startBtn.disabled = readOnly || active || busy;
  refs.stopBtn.disabled = readOnly || (!active && !busy);
  refs.restartBtn.disabled = readOnly || busy;

  if (status === 'backoff' && runtime.nextRetryAt) {
    const seconds = Math.max(0, Math.round((runtime.nextRetryAt - Date.now()) / 1000));
    refs.badge.textContent = `Reiniciando ${seconds}s`;
  }
}

function renderServices() {
  const visible = visibleServices();
  const visibleIds = new Set(visible.map((s) => s.id));

  for (const [id, refs] of cards) {
    if (!visibleIds.has(id)) {
      refs.node.remove();
      cards.delete(id);
    }
  }

  for (const service of visible) {
    if (!cards.has(service.id)) {
      const refs = createCard(service);
      grid.append(refs.node);
    }
    paintCard(service);
  }

  const noServices = state.services.length === 0;
  emptyState.hidden = !noServices;
  grid.style.display = noServices ? 'none' : '';

  renderStats();
  renderGroupFilter();
  refreshDashboard();
}

function renderStats() {
  const counts = { running: 0, stopped: 0, down: 0, problem: 0 };
  for (const service of state.services) {
    counts[statusOf(state.runtime[service.id])] += 1;
  }

  clear(statsNode);

  for (const bucket of STATUS_BUCKETS) {
    const active = state.status === bucket.key;
    const dot = el('span', { class: 'dot' });
    dot.style.background = bucket.color;

    const pill = el(
      'button',
      {
        class: `stat${active ? ' active' : ''}`,
        title: `Filtrar por ${bucket.label}`,
        onClick: () => {
          state.status = active ? 'all' : bucket.key;
          renderServices();
        },
      },
      [el('b', { text: String(counts[bucket.key]) }), dot, el('span', { text: bucket.label })]
    );
    statsNode.append(pill);
  }

  const total = el('div', { class: 'stat' }, [
    el('b', { text: String(state.services.length) }),
    el('span', { text: 'cadastrados' }),
  ]);
  statsNode.append(total);

  if (state.status !== 'all') {
    const bucket = STATUS_BUCKETS.find((b) => b.key === state.status);
    statsNode.append(
      el('button', {
        class: 'stat-filter-hint',
        text: `filtrando: ${bucket ? bucket.label : state.status} ✕`,
        title: 'Limpar filtro de status',
        onClick: () => {
          state.status = 'all';
          renderServices();
        },
      })
    );
  }
}

function renderGroupFilter() {
  const groups = [...new Set(state.services.map((s) => s.group))].sort();
  clear(groupFilter);

  const makeChip = (value, label, count) => {
    const chip = el('button', {
      class: `chip${state.group === value ? ' active' : ''}`,
      text: count === undefined ? label : `${label} (${count})`,
      onClick: () => {
        state.group = value;
        renderServices();
      },
    });
    return chip;
  };

  groupFilter.append(makeChip('all', 'Todos', state.services.length));
  for (const group of groups) {
    groupFilter.append(makeChip(group, group, state.services.filter((s) => s.group === group).length));
  }
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                            */
/* ------------------------------------------------------------------ */

let dashboardTimer = null;

/** Re-render do dashboard, com limite de frequencia (as metricas chegam a cada 2s). */
function refreshDashboard() {
  if (!dashboard) return;
  clearTimeout(dashboardTimer);
  dashboardTimer = setTimeout(() => {
    dashboard.render(state.services, state.runtime);
  }, 250);
}

/* ------------------------------------------------------------------ */
/* Acoes                                                                */
/* ------------------------------------------------------------------ */

function selectService(id, { toggle = false } = {}) {
  state.selectedId = toggle && state.selectedId === id ? null : id;
  logPanel.select(state.selectedId);
  for (const service of state.services) paintCard(service);
  // A janela e destruida ao ir para a bandeja: guardar a selecao para
  // quando ela voltar.
  try {
    localStorage.setItem('painel:selected', state.selectedId || '');
  } catch {
    /* localStorage pode estar indisponivel */
  }
}

function reportError(err) {
  console.error('[painel]', err);
  toast({ title: 'Erro', message: err.message, level: 'error' });
}

async function openNew() {
  openServiceForm(null, async (payload) => {
    await api.services.create(payload);
    toast({ title: 'Servico cadastrado', message: payload.name, level: 'success' });
  });
}

function openEdit(id) {
  const service = state.services.find((s) => s.id === id);
  if (!service) return;

  openServiceForm(service, async (payload) => {
    await api.services.update(id, payload);
    toast({ title: 'Servico atualizado', message: payload.name, level: 'success' });
  });
}

document.addEventListener('service:remove-request', async (event) => {
  const id = event.detail;
  const service = state.services.find((s) => s.id === id);
  if (!service) return;

  const confirmed = await confirmDialog({
    title: 'Excluir servico',
    message: `Remover "${service.name}" do painel? O processo em execucao nao sera encerrado automaticamente.`,
    confirmText: 'Excluir',
    danger: true,
  });
  if (!confirmed) return;

  try {
    await api.services.remove(id);
    toast({ title: 'Servico removido', message: service.name, level: 'info' });
  } catch (err) {
    reportError(err);
  }
});

/* ------------------------------------------------------------------ */
/* Eventos da interface                                                 */
/* ------------------------------------------------------------------ */

searchInput.addEventListener('input', () => {
  state.filter = searchInput.value.trim();
  renderServices();
});

onlyRunningInput.addEventListener('change', () => {
  state.onlyRunning = onlyRunningInput.checked;
  renderServices();
});

document.getElementById('btn-new').addEventListener('click', openNew);
document.getElementById('btn-empty-new').addEventListener('click', openNew);
document.getElementById('btn-start-all').addEventListener('click', () =>
  api.services.startAll().catch(reportError)
);
document.getElementById('btn-stop-all').addEventListener('click', () =>
  api.services.stopAll().catch(reportError)
);
document.getElementById('btn-discover').addEventListener('click', () =>
  openDiscovery(
    api,
    async (payload) => {
      await api.services.create(payload);
    },
    (containerName) =>
      state.services.some((s) => s.type === 'docker' && s.container === containerName)
  ).catch(reportError)
);

/* ------------------------------------------------------------------ */
/* Menu de opcoes do app                                                */
/* ------------------------------------------------------------------ */

const appMenuButton = document.getElementById('btn-app-menu');
const appMenu = document.getElementById('app-menu');
let autoStartEnabled = false;

async function renderAppMenu() {
  clear(appMenu);

  try {
    autoStartEnabled = Boolean(await api.app.autoStart());
  } catch {
    autoStartEnabled = false;
  }

  appMenu.append(
    menuItem('Iniciar com o Windows', autoStartEnabled, async () => {
      try {
        autoStartEnabled = await api.app.setAutoStart(!autoStartEnabled);
        toast({
          title: 'Inicialização automática',
          message: autoStartEnabled
            ? 'O painel vai subir com o Windows, direto na bandeja.'
            : 'O painel não vai mais subir com o Windows.',
          level: 'success',
        });
      } catch (err) {
        reportError(err);
      }
    }),
    el('div', { class: 'menu-sep' }),
    menuItem('Minimizar para a bandeja', null, () => {
      api.app.hideWindow().catch(reportError);
    }),
    menuItem('Recarregar painel', null, () => window.location.reload()),
    el('div', { class: 'menu-sep' }),
    el('div', {
      class: 'menu-note',
      text: 'Fechar a janela envia o painel para a bandeja: ele continua monitorando os serviços em segundo plano.',
    })
  );
}

function menuItem(label, checked, onClick) {
  return el('button', { class: 'menu-item', onClick }, [
    el('span', { class: `check${checked ? '' : ' off'}`, text: '✓' }),
    el('span', { text: label }),
  ]);
}

appMenuButton.addEventListener('click', async (event) => {
  event.stopPropagation();
  const wasOpen = appMenu.classList.contains('open');
  if (!wasOpen) await renderAppMenu();
  appMenu.classList.toggle('open');
});

document.addEventListener('click', (event) => {
  if (!appMenu.contains(event.target) && event.target !== appMenuButton) {
    appMenu.classList.remove('open');
  }
});

/* ------------------------------------------------------------------ */
/* Eventos do processo principal                                        */
/* ------------------------------------------------------------------ */

api.on.state((snapshot) => {
  state.runtime[snapshot.id] = { ...(state.runtime[snapshot.id] || {}), ...snapshot };
  const service = state.services.find((s) => s.id === snapshot.id);
  if (service) paintCard(service);
  // O status pode ter mudado de balde: refaz o filtro e os contadores.
  renderServices();
});

api.on.metrics((payload) => {
  for (const sample of payload) {
    state.runtime[sample.id] = { ...(state.runtime[sample.id] || {}), cpu: sample.cpu, mem: sample.mem };
    const service = state.services.find((s) => s.id === sample.id);
    if (service) paintCard(service);
  }
  refreshDashboard();
});

api.on.health((payload) => {
  const current = state.runtime[payload.id] || {};
  state.runtime[payload.id] = {
    ...current,
    health: payload.state,
    healthDetail: {
      latencyMs: payload.latencyMs,
      error: payload.error,
      status: payload.status,
      // Quem responde na porta (processo e pid).
      owner: payload.owner,
    },
  };
  const service = state.services.find((s) => s.id === payload.id);
  if (service) paintCard(service);
  renderServices();
});

api.on.log(({ id, entries }) => logPanel.append(id, entries));

api.on.notice((notice) => {
  const options = {
    title: notice.title || 'Aviso',
    message: notice.message,
    level: notice.level,
  };

  // Falhou por falta de permissao no Service Control Manager: oferecer
  // reiniciar o painel como administrador.
  if (notice.needsElevation) {
    options.timeout = 15000;
    options.action = {
      label: 'Reiniciar como administrador',
      onClick: () => {
        toast({ title: 'Painel', message: 'Reabrindo com permissao de administrador...', level: 'info' });
        api.app.relaunchElevated().catch(reportError);
      },
    };
  }

  toast(options);
});

api.on.list((services) => {
  state.services = services;
  logPanel.setServices(services);
  renderServices();
});

/* ------------------------------------------------------------------ */
/* Inicializacao                                                        */
/* ------------------------------------------------------------------ */

async function init() {
  logPanel = new LogPanel({ onSelect: selectService });
  dashboard = new Dashboard(document.getElementById('dashboard'));

  try {
    const [services, runtime] = await Promise.all([api.services.list(), api.services.state()]);
    state.services = services;
    state.runtime = runtime || {};

    for (const service of services) {
      const buffer = await api.services.logs(service.id);
      logPanel.buffers.set(service.id, buffer || []);
    }

    logPanel.setServices(services);
    renderServices();

    // Restaura o servico que estava selecionado antes de ir para a bandeja.
    try {
      const saved = localStorage.getItem('painel:selected');
      if (saved && services.some((s) => s.id === saved)) {
        state.selectedId = saved;
        logPanel.select(saved);
        for (const service of services) paintCard(service);
      }
    } catch {
      /* localStorage pode estar indisponivel */
    }

    const sub = document.getElementById('brand-sub');
    sub.textContent = `${services.length} servico(s) | atualizacao em tempo real`;
  } catch (err) {
    reportError(err);
  }

  // Atualiza uptime a cada segundo (o runtime so recebe eventos em mudanca de estado).
  setInterval(() => {
    const now = Date.now();
    for (const service of state.services) {
      const runtime = state.runtime[service.id];
      if (!runtime?.startedAt) continue;
      runtime.uptimeMs = now - runtime.startedAt;
      paintCard(service);
    }
  }, 1000);
}

init();

import { el, clear, formatUptime, STATE_LABELS, HEALTH_LABELS } from './util.js';
import { openServiceForm } from './service-form.js';
import { openDiscovery } from './discovery.js';
import { LogPanel } from './log-panel.js';
import { confirmDialog, closeModal } from './modal.js';
import { toast } from './toast.js';

const api = window.api;

const state = {
  services: [],
  runtime: {},
  selectedId: null,
  filter: '',
  group: 'all',
  onlyRunning: false,
};

const cards = new Map(); // id -> { node, refs }
let logPanel = null;

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
  const badge = el('span', { class: 'badge stopped', text: 'Parado' });
  const cmd = el('div', { class: 'cmd' });
  const portValue = el('dd', { text: '--' });
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
      el('div', { class: 'card-title' }, [name, el('div', { class: 'card-sub' }, [groupTag])]),
      badge,
    ]),
    cmd,
    el('dl', { class: 'meta' }, [
      el('div', {}, [el('dt', { text: 'Porta' }), portValue]),
      el('div', {}, [el('dt', { text: 'PID' }), pidValue]),
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
    portValue,
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

  refs.node.dataset.status = status;
  refs.node.classList.toggle('selected', state.selectedId === service.id);
  refs.dot.className = `dot ${status}`;
  refs.badge.className = `badge ${status}`;
  refs.badge.textContent = STATE_LABELS[status] || status;

  const parts = [service.command, ...(service.args || [])].filter(Boolean);
  refs.cmd.textContent = parts.length ? parts.join(' ') : '(somente monitorar)';
  refs.cmd.title = refs.cmd.textContent;

  refs.portValue.textContent = service.health?.port ? service.health.port : '--';
  refs.pidValue.textContent = runtime.pid ?? '--';

  // Metricas so fazem sentido com o processo em execucao.
  const live = ['running', 'starting'].includes(status);
  refs.cpuValue.textContent = live && runtime.cpu !== undefined ? `${runtime.cpu}%` : '--';
  refs.memValue.textContent = live && runtime.mem !== undefined ? `${runtime.mem} MB` : '--';

  const health = runtime.health || 'unknown';
  refs.healthDot.className = `health-dot ${health}`;
  refs.healthText.textContent = service.health?.type === 'none'
    ? 'sem verificacao'
    : `${HEALTH_LABELS[health] || health}${runtime.healthDetail?.latencyMs ? ` (${runtime.healthDetail.latencyMs}ms)` : ''}`;

  const active = ['running', 'starting'].includes(status);
  const busy = ['starting', 'stopping', 'backoff'].includes(status);
  refs.startBtn.disabled = active || busy;
  refs.stopBtn.disabled = !active && !busy;
  refs.restartBtn.disabled = busy;

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
}

function renderStats() {
  const counts = { running: 0, stopped: 0, problem: 0, total: state.services.length };
  for (const service of state.services) {
    const runtime = state.runtime[service.id];
    const status = runtime?.state || 'stopped';
    if (status === 'running') counts.running += 1;
    else if (status === 'stopped') counts.stopped += 1;
    else counts.problem += 1;
  }

  clear(statsNode);
  statsNode.append(
    statItem(counts.running, 'rodando', 'var(--ok)'),
    statItem(counts.stopped, 'parados', 'var(--idle)'),
    statItem(counts.problem, 'com problema', 'var(--warn)'),
    statItem(counts.total, 'cadastrados', 'var(--accent)')
  );
}

function statItem(value, label, color) {
  const dot = el('span', { class: 'dot' });
  dot.style.background = color;
  return el('div', { class: 'stat' }, [el('b', { text: String(value) }), dot, el('span', { text: label })]);
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
/* Acoes                                                                */
/* ------------------------------------------------------------------ */

function selectService(id, { toggle = false } = {}) {
  state.selectedId = toggle && state.selectedId === id ? null : id;
  logPanel.select(state.selectedId);
  for (const service of state.services) paintCard(service);
}

function reportError(err) {
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
  openDiscovery(api, async (payload) => {
    await api.services.create(payload);
  }).catch(reportError)
);

/* ------------------------------------------------------------------ */
/* Eventos do processo principal                                        */
/* ------------------------------------------------------------------ */

api.on.state((snapshot) => {
  state.runtime[snapshot.id] = { ...(state.runtime[snapshot.id] || {}), ...snapshot };
  const service = state.services.find((s) => s.id === snapshot.id);
  if (service) paintCard(service);
  renderStats();
});

api.on.metrics((payload) => {
  for (const sample of payload) {
    state.runtime[sample.id] = { ...(state.runtime[sample.id] || {}), cpu: sample.cpu, mem: sample.mem };
    const service = state.services.find((s) => s.id === sample.id);
    if (service) paintCard(service);
  }
});

api.on.health((payload) => {
  const current = state.runtime[payload.id] || {};
  state.runtime[payload.id] = {
    ...current,
    health: payload.state,
    healthDetail: { latencyMs: payload.latencyMs, error: payload.error, status: payload.status },
  };
  const service = state.services.find((s) => s.id === payload.id);
  if (service) paintCard(service);
});

api.on.log(({ id, entries }) => logPanel.append(id, entries));

api.on.notice((notice) => {
  toast({ title: notice.title, message: notice.message, level: notice.level });
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

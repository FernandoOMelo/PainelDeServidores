import { el, clear, formatBytes } from './util.js';

const MAX_ITEMS = 6;
const STORAGE_KEY = 'painel:dashboard:expanded';

/**
 * Painel com o somatorio das metricas de todos os servicos:
 * CPU total, memoria total e os maiores consumidores.
 */
export class Dashboard {
  constructor(root) {
    this.root = root;
    this.expanded = readExpanded();
    this.sortBy = 'mem';
  }

  toggle() {
    this.expanded = !this.expanded;
    this.root.classList.toggle('collapsed', !this.expanded);
    try {
      localStorage.setItem(STORAGE_KEY, this.expanded ? '1' : '0');
    } catch {
      /* localStorage pode estar indisponivel */
    }
    return this.expanded;
  }

  render(services, runtime) {
    clear(this.root);
    this.root.classList.toggle('collapsed', !this.expanded);

    const items = services
      .map((service) => ({ service, rt: runtime[service.id] || {} }))
      .filter((item) => item.rt.cpu !== undefined || item.rt.mem !== undefined);

    const cpuTotal = items.reduce((sum, item) => sum + (item.rt.cpu || 0), 0);
    const memTotal = items.reduce((sum, item) => sum + (item.rt.mem || 0), 0);

    const toggle = el('button', {
      class: 'dash-toggle',
      title: this.expanded ? 'Recolher o dashboard' : 'Expandir o dashboard',
      text: this.expanded ? '▾' : '▸',
      onClick: () => {
        this.toggle();
        this.render(services, runtime);
      },
    });

    this.root.append(
      el('div', { class: 'dash-head' }, [el('span', { text: 'Dashboard' }), toggle])
    );

    this.root.append(
      el('div', { class: 'dash-metrics' }, [
        metricTile('CPU total', `${cpuTotal.toFixed(1)}%`, cpuTotal, 100, 'cpu'),
        metricTile('Memoria total', formatBytes(memTotal), memTotal, 1024 * 4, 'mem'),
        metricTile('Com metricas', String(items.length), items.length, Math.max(services.length, 1), 'count'),
      ])
    );

    if (!this.expanded) return;

    if (!items.length) {
      this.root.append(
        el('div', { class: 'dash-empty', text: 'Sem metricas ainda - inicie um servico para acompanhar CPU e memoria.' })
      );
      return;
    }

    const sorted = [...items].sort((a, b) => {
      if (this.sortBy === 'cpu') return (b.rt.cpu || 0) - (a.rt.cpu || 0);
      return (b.rt.mem || 0) - (a.rt.mem || 0);
    });
    const top = sorted.slice(0, MAX_ITEMS);

    const maxValue = Math.max(
      ...top.map((item) => (this.sortBy === 'cpu' ? item.rt.cpu || 0 : item.rt.mem || 0)),
      0.001
    );

    const rows = top.map((item) => {
      const value = this.sortBy === 'cpu' ? item.rt.cpu || 0 : item.rt.mem || 0;
      const percent = (value / maxValue) * 100;

      return el('div', { class: 'dash-row' }, [
        el('span', { class: 'dash-name', text: item.service.name, title: item.service.name }),
        el('span', { class: 'dash-bar' }, [
          el('span', { class: 'dash-fill', style: `width:${percent.toFixed(1)}%` }),
        ]),
        el('span', {
          class: 'dash-value',
          text: this.sortBy === 'cpu' ? `${(item.rt.cpu || 0).toFixed(1)}%` : formatBytes(item.rt.mem || 0),
        }),
        el('span', {
          class: 'dash-alt',
          text: this.sortBy === 'cpu' ? formatBytes(item.rt.mem || 0) : `${(item.rt.cpu || 0).toFixed(1)}%`,
        }),
      ]);
    });

    const header = el('div', { class: 'dash-sub' }, [
      el('span', { text: 'Maiores consumidores' }),
      el('div', { class: 'dash-sort' }, [
        sortButton('Memoria', 'mem', this.sortBy, () => this.render(services, runtime)),
        sortButton('CPU', 'cpu', this.sortBy, () => this.render(services, runtime)),
      ]),
    ]);

    this.root.append(header, el('div', { class: 'dash-list' }, rows));
  }
}

function readExpanded() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function metricTile(label, value, current, max, kind) {  const percent = Math.min(100, (current / max) * 100);
  return el('div', { class: `dash-tile dash-${kind}` }, [
    el('span', { class: 'dash-tile-label', text: label }),
    el('span', { class: 'dash-tile-value', text: value }),
    el('span', { class: 'dash-tile-bar' }, [
      el('span', { class: 'dash-tile-fill', style: `width:${percent.toFixed(1)}%` }),
    ]),
  ]);
}

function sortButton(label, value, current, onClick) {
  return el('button', {
    class: `dash-sort-btn${current === value ? ' active' : ''}`,
    text: label,
    onClick,
  });
}

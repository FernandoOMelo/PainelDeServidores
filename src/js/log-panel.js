import { el, clear, formatClock } from './util.js';

const MAX_BUFFER = 3000;

/**
 * Painel de logs: mantem um buffer por servico e renderiza o servico
 * selecionado, aplicando filtro por texto e auto-scroll.
 */
export class LogPanel {
  constructor({ onSelect }) {
    this.buffers = new Map();
    this.services = new Map();
    this.selectedId = null;
    this.filter = '';
    this.autoScroll = true;
    this.onSelect = onSelect;

    this.titleNode = document.getElementById('log-title');
    this.subNode = document.getElementById('log-sub');
    this.bodyNode = document.getElementById('log-body');
    this.searchInput = document.getElementById('log-search');

    this.searchInput.addEventListener('input', () => {
      this.filter = this.searchInput.value.trim().toLowerCase();
      this.render();
    });

    document.getElementById('autoscroll').addEventListener('change', (event) => {
      this.autoScroll = event.target.checked;
    });

    document.getElementById('btn-clear-logs').addEventListener('click', () => {
      if (!this.selectedId) return;
      this.buffers.set(this.selectedId, []);
      this.render();
    });
  }

  setServices(services) {
    this.services.clear();
    for (const service of services) {
      this.services.set(service.id, service);
      if (!this.buffers.has(service.id)) this.buffers.set(service.id, []);
    }
    if (this.selectedId && !this.services.has(this.selectedId)) this.selectedId = null;
  }

  get currentService() {
    return this.selectedId ? this.services.get(this.selectedId) ?? null : null;
  }

  select(id) {
    this.selectedId = id;
    this.render();
  }

  append(id, entries) {
    if (!entries?.length) return;
    const buffer = this.buffers.get(id) || [];
    buffer.push(...entries);
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
    this.buffers.set(id, buffer);
    if (id === this.selectedId) this.render();
  }

  clearBuffer(id) {
    this.buffers.set(id, []);
    if (id === this.selectedId) this.render();
  }

  render() {
    const service = this.currentService;
    this.titleNode.textContent = service ? service.name : 'Logs';
    this.subNode.textContent = service
      ? `${service.command || 'somente monitorar'}`
      : 'selecione um servico';

    clear(this.bodyNode);

    if (!service) {
      this.bodyNode.append(
        el('div', { class: 'log-placeholder' }, [
          el('p', { text: 'Selecione um servico para ver a saida em tempo real.' }),
        ])
      );
      return;
    }

    const buffer = this.buffers.get(service.id) || [];
    const visible = this.filter
      ? buffer.filter((entry) => entry.text.toLowerCase().includes(this.filter))
      : buffer;

    if (!visible.length) {
      this.bodyNode.append(
        el('div', { class: 'log-empty', text: this.filter ? 'Nenhuma linha corresponde ao filtro.' : 'Sem logs ainda.' })
      );
      return;
    }

    const frag = document.createDocumentFragment();
    for (const entry of visible) {
      frag.append(
        el('div', { class: `log-line ${entry.stream}` }, [
          el('span', { class: 'log-time', text: formatClock(entry.ts) }),
          el('span', { class: 'log-text', text: entry.text }),
        ])
      );
    }
    this.bodyNode.append(frag);

    if (this.autoScroll) this.bodyNode.scrollTop = this.bodyNode.scrollHeight;
  }
}

import { el, clear } from './util.js';

const modalRoot = () => document.getElementById('modal-root');

let activeBackdrop = null;

export function openModal({ title, body, footer, wide = false, onClose }) {
  closeModal();

  const modal = el('div', { class: `modal${wide ? ' wide' : ''}` }, [
    el('div', { class: 'modal-head' }, [
      el('h2', { text: title }),
      el('button', { class: 'btn btn-icon btn-ghost', text: '✕', title: 'Fechar', onClick: () => closeModal() }),
    ]),
    el('div', { class: 'modal-body' }, [body]),
    footer ? el('div', { class: 'modal-foot' }, [footer]) : null,
  ]);

  const backdrop = el('div', { class: 'modal-backdrop' }, [modal]);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) closeModal();
  });

  const onKey = (event) => {
    if (event.key === 'Escape') closeModal();
  };
  document.addEventListener('keydown', onKey);

  activeBackdrop = {
    node: backdrop,
    onKey,
    onClose,
  };
  modalRoot().append(backdrop);

  const focusTarget = modal.querySelector('input, select, textarea, button');
  focusTarget?.focus();

  return { close: closeModal, modal, body };
}

export function closeModal() {
  if (!activeBackdrop) return;
  document.removeEventListener('keydown', activeBackdrop.onKey);
  activeBackdrop.node.remove();
  activeBackdrop.onClose?.();
  activeBackdrop = null;
}

export function isModalOpen() {
  return Boolean(activeBackdrop);
}

/** Campo de formulario com rotulo, controle e dica. */
export function field(label, control, hint) {
  return el('div', { class: 'field' }, [
    el('label', { text: label }),
    control,
    hint ? el('div', { class: 'hint', text: hint }) : null,
  ]);
}

export function input(attrs = {}) {
  return el('input', { type: 'text', ...attrs });
}

export function numberInput(attrs = {}) {
  return el('input', { type: 'number', ...attrs });
}

export function select(options, value) {
  const node = el('select');
  for (const option of options) {
    node.append(el('option', { value: option.value, text: option.label }));
  }
  if (value !== undefined && value !== null) node.value = String(value);
  return node;
}

export function checkbox(label, checked) {
  const box = el('input', { type: 'checkbox' });
  box.checked = Boolean(checked);
  return el('label', { class: 'checkbox' }, [box, el('span', { text: label })]);
}

export function confirmDialog({ title, message, confirmText = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      closeModal();
    };

    const footer = el('div', { style: 'display:flex;gap:8px' }, [
      el('button', { class: 'btn btn-ghost', text: 'Cancelar', onClick: () => finish(false) }),
      el('button', {
        class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
        text: confirmText,
        onClick: () => finish(true),
      }),
    ]);

    openModal({
      title,
      body: el('p', { text: message, style: 'color:var(--text-dim);font-size:13px' }),
      footer,
      onClose: () => finish(false),
    });
  });
}

export { clear };

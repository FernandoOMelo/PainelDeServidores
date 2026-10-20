import { el } from './util.js';

const root = () => document.getElementById('toast-root');

export function toast({ title, message, level = 'info', timeout = 4200, action }) {
  const node = el('div', { class: `toast ${level}` }, [
    el('h4', { text: title }),
    message ? el('p', { text: message }) : null,
  ]);

  if (action) {
    node.append(
      el('button', {
        class: 'btn btn-primary',
        text: action.label,
        onClick: () => {
          node.remove();
          action.onClick?.();
        },
      })
    );
  }

  root().append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s ease, transform .2s ease';
    node.style.opacity = '0';
    node.style.transform = 'translateX(20px)';
    setTimeout(() => node.remove(), 220);
  }, timeout);
  return node;
}

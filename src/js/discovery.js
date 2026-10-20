import { el } from './util.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';

/**
 * Escaneia portas em escuta na maquina e permite cadastrar servicos
 * "somente monitorar" para servidores que ja rodam fora do painel.
 */
export async function openDiscovery(api, onCreated) {
  const listNode = el('div', { class: 'discovery-list' }, [
    el('div', { class: 'log-empty', text: 'Procurando processos que escutam portas...' }),
  ]);

  const modal = openModal({
    title: 'Descobrir servidores rodando',
    body: el('div', {}, [
      el('p', {
        text: 'Portas abertas na maquina que ainda nao estao cadastradas no painel.',
        style: 'color:var(--text-dim);font-size:12.5px;margin-bottom:14px',
      }),
      listNode,
    ]),
    footer: el('div', { style: 'display:flex;gap:8px' }, [
      el('button', { class: 'btn btn-ghost', text: 'Fechar', onClick: () => modal.close() }),
    ]),
  });

  let entries = [];
  try {
    entries = await api.discovery.scan();
  } catch (err) {
    listNode.replaceChildren(el('div', { class: 'log-empty', text: `Falha na varredura: ${err.message}` }));
    return;
  }

  if (!entries.length) {
    listNode.replaceChildren(
      el('div', { class: 'log-empty', text: 'Nenhuma porta em escuta fora do painel foi encontrada.' })
    );
    return;
  }

  const checkboxes = [];

  const addBtn = el('button', {
    class: 'btn btn-primary',
    text: 'Cadastrar selecionados',
    onClick: async () => {
      const selected = entries.filter((_, index) => checkboxes[index].checked);
      if (!selected.length) {
        toast({ title: 'Nada selecionado', message: 'Escolha ao menos uma porta.', level: 'warn' });
        return;
      }
      addBtn.disabled = true;
      for (const entry of selected) {
        await onCreated({
          name: `${entry.process} :${entry.port}`,
          group: 'Descobertos',
          command: '',
          args: [],
          cwd: '',
          env: {},
          monitorOnly: true,
          health: {
            type: 'tcp',
            port: entry.port,
            path: '/',
            expectStatus: 200,
            intervalMs: 5000,
            timeoutMs: 2000,
            graceMs: 0,
            failuresBeforeUnhealthy: 2,
          },
        });
      }
      toast({
        title: 'Servidores adotados',
        message: `${selected.length} servico(s) em modo somente monitorar.`,
        level: 'success',
      });
      modal.close();
    },
  });

  modal.modal.querySelector('.modal-foot').append(addBtn);

  const rows = entries.map((entry, index) => {
    const box = el('input', { type: 'checkbox' });
    checkboxes.push(box);
    return el('label', { class: 'discovery-item' }, [
      box,
      el('span', { class: 'port', text: `:${entry.port}` }),
      el('span', { class: 'proc', text: entry.process }),
      el('span', { class: 'pid', text: `pid ${entry.pid}` }),
      el('span', {
        class: 'tag',
        text: entry.reachable ? 'respondendo' : 'sem resposta',
      }),
    ]);
  });

  listNode.replaceChildren(...rows);
}

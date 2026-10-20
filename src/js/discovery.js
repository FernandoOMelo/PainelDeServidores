import { el } from './util.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';

/**
 * Escaneia portas em escuta na maquina e containers Docker, para permitir
 * cadastrar servicos que ja rodam fora do painel.
 */
export async function openDiscovery(api, onCreated, isRegistered = () => false) {
  const portList = el('div', { class: 'discovery-list' }, [
    el('div', { class: 'log-empty', text: 'Procurando processos que escutam portas...' }),
  ]);
  const dockerList = el('div', { class: 'discovery-list' }, [
    el('div', { class: 'log-empty', text: 'Consultando o Docker...' }),
  ]);

  const modal = openModal({
    title: 'Descobrir servidores rodando',
    body: el('div', {}, [
      el('p', {
        text: 'Portas abertas e containers Docker que ainda nao estao cadastrados no painel.',
        style: 'color:var(--text-dim);font-size:12.5px;margin-bottom:14px',
      }),
      el('div', { class: 'section-title', text: 'Contêineres Docker' }),
      dockerList,
      el('div', { class: 'section-title', text: 'Portas em escuta' }),
      portList,
    ]),
    footer: el('div', { style: 'display:flex;gap:8px' }, [
      el('button', { class: 'btn btn-ghost', text: 'Fechar', onClick: () => modal.close() }),
    ]),
    wide: true,
  });

  await Promise.all([
    loadPorts(api, portList, onCreated, modal),
    loadContainers(api, dockerList, onCreated, modal, isRegistered),
  ]);
}

/* ------------------------------------------------------------------ */
/* Portas                                                               */
/* ------------------------------------------------------------------ */

async function loadPorts(api, listNode, onCreated, modal) {
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
  const rows = entries.map((entry) => {
    const box = el('input', { type: 'checkbox' });
    checkboxes.push(box);
    return el('label', { class: 'discovery-item' }, [
      box,
      el('span', { class: 'port', text: `:${entry.port}` }),
      el('span', { class: 'proc', text: entry.process }),
      el('span', { class: 'pid', text: `pid ${entry.pid}` }),
      el('span', { class: 'tag', text: entry.reachable ? 'respondendo' : 'sem resposta' }),
    ]);
  });
  listNode.replaceChildren(...rows);

  const addBtn = el('button', {
    class: 'btn btn-primary',
    text: 'Cadastrar portas selecionadas',
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
          type: 'processo',
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
}

/* ------------------------------------------------------------------ */
/* Containers Docker                                                    */
/* ------------------------------------------------------------------ */

async function loadContainers(api, listNode, onCreated, modal, isRegistered) {
  let status;
  try {
    status = await api.docker.status();
  } catch (err) {
    listNode.replaceChildren(el('div', { class: 'log-empty', text: `Docker indisponivel: ${err.message}` }));
    return;
  }

  if (!status.ok) {
    listNode.replaceChildren(
      el('div', { class: 'log-empty', text: `Docker indisponivel: ${status.error}` })
    );
    return;
  }

  let containers = [];
  try {
    containers = await api.docker.containers();
  } catch (err) {
    listNode.replaceChildren(el('div', { class: 'log-empty', text: `Falha ao listar: ${err.message}` }));
    return;
  }

  // Containers ja cadastrados nao aparecem de novo.
  const pending = containers.filter((c) => !isRegistered(c.name));

  if (!pending.length) {
    listNode.replaceChildren(
      el('div', { class: 'log-empty', text: 'Todos os containers ja estao cadastrados no painel.' })
    );
    return;
  }

  if (pending.length !== containers.length) {
    listNode.prepend(
      el('div', {
        class: 'hint',
        text: `${pending.length} de ${containers.length} containers ainda nao cadastrados no painel.`,
      })
    );
  }

  const checkboxes = [];
  const rows = pending.map((container) => {
    const box = el('input', { type: 'checkbox' });
    checkboxes.push(box);
    const running = container.state === 'running';
    return el('label', { class: 'discovery-item' }, [
      box,
      el('span', { class: 'container-name', text: container.name, title: container.name }),
      el('span', { class: 'proc', text: container.image, title: container.image }),
      el('span', {
        class: `tag${running ? ' tag-accent' : ''}`,
        text: container.status?.slice(0, 28) || container.state,
      }),
    ]);
  });
  listNode.replaceChildren(...rows);

  const addBtn = el('button', {
    class: 'btn btn-primary',
    text: 'Cadastrar containers selecionados',
    onClick: async () => {
      const selected = pending.filter((_, index) => checkboxes[index].checked);
      if (!selected.length) {
        toast({ title: 'Nada selecionado', message: 'Escolha ao menos um container.', level: 'warn' });
        return;
      }
      addBtn.disabled = true;
      for (const container of selected) {
        await onCreated({
          name: container.name,
          group: 'Docker',
          type: 'docker',
          command: '',
          args: [],
          cwd: '',
          env: {},
          container: container.name,
          monitorOnly: false,
          health: { type: 'none' },
        });
      }
      toast({
        title: 'Containers cadastrados',
        message: `${selected.length} container(s) no painel.`,
        level: 'success',
      });
      modal.close();
    },
  });

  modal.modal.querySelector('.modal-foot').append(addBtn);
}

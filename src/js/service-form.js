import { el } from './util.js';
import { openModal, field, input, numberInput, select, checkbox } from './modal.js';
import { parseEnv, stringifyEnv, splitArgs } from './util.js';

const DEFAULT_SERVICE = {
  name: '',
  group: 'Geral',
  command: '',
  args: [],
  cwd: '',
  env: {},
  shell: false,
  autostart: false,
  monitorOnly: false,
  health: {
    type: 'none',
    port: '',
    path: '/',
    expectStatus: 200,
    intervalMs: 5000,
    timeoutMs: 3000,
    graceMs: 10000,
    failuresBeforeUnhealthy: 3,
  },
  restart: {
    enabled: true,
    maxRetries: 5,
    backoffMs: 1000,
    maxBackoffMs: 30000,
    restartOnUnhealthy: true,
    stabilityMs: 60000,
  },
};

/**
 * Abre o formulario de cadastro/edicao de um servico.
 * @param {object|null} service servico existente ou null para novo
 * @param {(payload:object)=>Promise<void>|void} onSubmit
 */
export function openServiceForm(service, onSubmit) {
  const data = service
    ? {
        ...DEFAULT_SERVICE,
        ...service,
        health: { ...DEFAULT_SERVICE.health, ...service.health },
        restart: { ...DEFAULT_SERVICE.restart, ...service.restart },
      }
    : structuredClone(DEFAULT_SERVICE);

  const isEdit = Boolean(service);

  // --- campos ---
  const nameInput = input({ value: data.name, placeholder: 'API Principal' });
  const groupInput = input({ value: data.group, placeholder: 'Geral', list: 'group-options' });
  const commandInput = input({
    value: data.command,
    placeholder: 'npm',
    class: 'mono',
    spellcheck: false,
  });
  const argsInput = input({
    value: Array.isArray(data.args) ? data.args.join(' ') : data.args || '',
    placeholder: 'run dev',
    class: 'mono',
    spellcheck: false,
  });
  const cwdInput = input({
    value: data.cwd || '',
    placeholder: 'C:\\projetos\\api',
    class: 'mono',
    spellcheck: false,
  });
  const envInput = el('textarea', {
    class: 'mono',
    placeholder: 'PORT=3000\nNODE_ENV=development',
    spellcheck: false,
  });
  envInput.value = stringifyEnv(data.env);

  const shellCheck = checkbox('Executar atraves do shell do sistema', data.shell);
  const autostartCheck = checkbox('Iniciar automaticamente ao abrir o app', data.autostart);
  const monitorOnlyCheck = checkbox(
    'Somente monitorar (nao iniciar/parar este servico)',
    data.monitorOnly
  );

  // --- health check ---
  const healthType = select(
    [
      { value: 'none', label: 'Nenhum' },
      { value: 'tcp', label: 'Porta TCP' },
      { value: 'http', label: 'HTTP' },
    ],
    data.health.type
  );
  const portInput = numberInput({ value: data.health.port ?? '', placeholder: '3000', min: 1, max: 65535 });
  const pathInput = input({ value: data.health.path || '/', placeholder: '/health', class: 'mono' });
  const statusInput = numberInput({ value: data.health.expectStatus, min: 0, max: 599 });
  const intervalInput = numberInput({ value: data.health.intervalMs, min: 1000, step: 500 });
  const timeoutInput = numberInput({ value: data.health.timeoutMs, min: 500, step: 500 });
  const graceInput = numberInput({ value: data.health.graceMs, min: 0, step: 1000 });
  const failuresInput = numberInput({ value: data.health.failuresBeforeUnhealthy, min: 1, max: 20 });

  const healthFields = el('div', { class: 'fieldset-hidden' }, [
    el('div', { class: 'row' }, [
      field('Porta', portInput),
      field('Caminho (HTTP)', pathInput),
    ]),
    el('div', { class: 'row' }, [
      field('Status esperado (0 = qualquer 2xx/3xx)', statusInput),
      field('Intervalo (ms)', intervalInput),
    ]),
    el('div', { class: 'row' }, [
      field('Timeout (ms)', timeoutInput),
      field('Atraso inicial (ms)', graceInput, 'Espera antes da primeira verificacao apos iniciar.'),
    ]),
    field('Falhas consecutivas para considerar fora do ar', failuresInput),
  ]);

  const toggleHealthFields = () => {
    healthFields.classList.toggle('fieldset-hidden', healthType.value === 'none');
    pathInput.closest('.field').style.display = healthType.value === 'http' ? '' : 'none';
  };
  healthType.addEventListener('change', toggleHealthFields);
  toggleHealthFields();

  // --- reinicio automatico ---
  const restartEnabled = checkbox('Reiniciar automaticamente quando o processo cair', data.restart.enabled);
  const maxRetriesInput = numberInput({ value: data.restart.maxRetries, min: 0, max: 100 });
  const backoffInput = numberInput({ value: data.restart.backoffMs, min: 100, step: 500 });
  const maxBackoffInput = numberInput({ value: data.restart.maxBackoffMs, min: 100, step: 1000 });
  const stabilityInput = numberInput({ value: data.restart.stabilityMs, min: 5000, step: 5000 });
  const restartOnUnhealthy = checkbox('Reiniciar tambem quando o health check falhar', data.restart.restartOnUnhealthy);

  const restartFields = el('div', {}, [
    el('div', { class: 'row' }, [
      field('Tentativas maximas', maxRetriesInput),
      field('Intervalo inicial (ms)', backoffInput, 'Cresce exponencialmente a cada tentativa.'),
    ]),
    el('div', { class: 'row' }, [
      field('Intervalo maximo (ms)', maxBackoffInput),
      field('Estavel por (ms)', stabilityInput, 'Tempo rodando que zera o contador de reinicios.'),
    ]),
    el('div', { class: 'checks' }, [restartOnUnhealthy]),
  ]);
  restartFields.classList.toggle('fieldset-hidden', !data.restart.enabled);
  restartEnabled.querySelector('input').addEventListener('change', (event) => {
    restartFields.classList.toggle('fieldset-hidden', !event.target.checked);
  });

  const errorText = el('div', { class: 'error-text' });

  const body = el('div', {}, [
    el('div', { class: 'row' }, [field('Nome', nameInput), field('Grupo', groupInput)]),
    field('Comando', commandInput, 'Executavel a ser chamado (ex.: npm, node, python, dotnet).'),
    field('Argumentos', argsInput, 'Separados por espaco. Use aspas para argumentos com espaco.'),
    field('Diretorio de trabalho', cwdInput, 'Onde o comando sera executado. Vazio usa a pasta do app; caminho relativo e resolvido a partir dela.'),
    field('Variaveis de ambiente', envInput, 'Uma por linha, no formato CHAVE=VALOR.'),
    el('div', { class: 'checks' }, [shellCheck, autostartCheck, monitorOnlyCheck]),

    el('div', { class: 'section' }, [
      el('div', { class: 'section-title', text: 'Verificacao de saude' }),
      field('Tipo', healthType),
      healthFields,
    ]),

    el('div', { class: 'section' }, [
      el('div', { class: 'section-title', text: 'Recuperacao automatica' }),
      restartEnabled,
      restartFields,
    ]),

    errorText,
  ]);

  const submitBtn = el('button', { class: 'btn btn-primary', text: isEdit ? 'Salvar alteracoes' : 'Cadastrar servico' });

  const submit = async () => {
    const name = nameInput.value.trim();
    const command = commandInput.value.trim();

    if (!name) {
      errorText.textContent = 'Informe um nome para o servico.';
      nameInput.focus();
      return;
    }
    if (!data.monitorOnly && !command) {
      errorText.textContent = 'Informe o comando que inicia o servico.';
      commandInput.focus();
      return;
    }
    if (healthType.value !== 'none') {
      const port = Number(portInput.value);
      if (!port || port < 1 || port > 65535) {
        errorText.textContent = 'Informe uma porta valida para a verificacao de saude.';
        portInput.focus();
        return;
      }
    }

    errorText.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Salvando...';

    const payload = {
      id: data.id,
      name,
      group: groupInput.value.trim() || 'Geral',
      command,
      args: splitArgs(argsInput.value),
      cwd: cwdInput.value.trim(),
      env: parseEnv(envInput.value),
      shell: shellCheck.querySelector('input').checked,
      autostart: autostartCheck.querySelector('input').checked,
      monitorOnly: monitorOnlyCheck.querySelector('input').checked,
      health: {
        type: healthType.value,
        port: healthType.value === 'none' ? null : Number(portInput.value),
        path: pathInput.value.trim() || '/',
        expectStatus: Number(statusInput.value) || 200,
        intervalMs: Number(intervalInput.value) || 5000,
        timeoutMs: Number(timeoutInput.value) || 3000,
        graceMs: Number(graceInput.value) || 0,
        failuresBeforeUnhealthy: Number(failuresInput.value) || 3,
      },
      restart: {
        enabled: restartEnabled.querySelector('input').checked,
        maxRetries: Number(maxRetriesInput.value) || 0,
        backoffMs: Number(backoffInput.value) || 1000,
        maxBackoffMs: Number(maxBackoffInput.value) || 30000,
        restartOnUnhealthy: restartOnUnhealthy.querySelector('input').checked,
        stabilityMs: Number(stabilityInput.value) || 60000,
      },
    };

    try {
      await onSubmit(payload);
      modal.close();
    } catch (err) {
      errorText.textContent = err.message;
      submitBtn.disabled = false;
      submitBtn.textContent = isEdit ? 'Salvar alteracoes' : 'Cadastrar servico';
    }
  };

  submitBtn.addEventListener('click', submit);

  const footer = el('div', { style: 'display:flex;gap:8px;width:100%' }, [
    isEdit
      ? el('button', {
          class: 'btn btn-danger left',
          text: 'Excluir',
          onClick: () => {
            document.dispatchEvent(new CustomEvent('service:remove-request', { detail: data.id }));
          },
        })
      : null,
    el('button', { class: 'btn btn-ghost', text: 'Cancelar', onClick: () => modal.close() }),
    submitBtn,
  ]);

  const modal = openModal({
    title: isEdit ? `Editar ${data.name}` : 'Novo servico',
    body,
    footer,
    wide: true,
  });

  return modal;
}

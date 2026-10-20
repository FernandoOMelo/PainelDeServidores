/**
 * Camada de acesso a API do app.
 *
 * O frontend fala com o Tauri atraves de `invoke` (comandos) e `listen`
 * (eventos empurrados pelo processo principal). O contrato e o mesmo do
 * painel em JavaScript, entao o resto do codigo nao conhece o backend.
 */

const tauri = window.__TAURI__;

if (!tauri) {
  throw new Error('API do Tauri indisponivel: o app precisa rodar dentro do painel.');
}

const CHANNEL_EVENT = 'painel-evento';

function invoke(command, args) {
  return tauri.core.invoke(command, args);
}

/** Assina um evento do app, filtrando pelo canal. */
function onChannel(canal, callback) {
  return tauri.event.listen(CHANNEL_EVENT, (evento) => {
    const payload = evento.payload;
    if (!payload || payload.canal !== canal) return;
    callback(payload.dados);
  });
}

const api = {
  services: {
    list: () => invoke('servicos_listar'),
    state: () => invoke('servicos_estado'),
    create: (definicao) => invoke('servicos_criar', { definicao }),
    update: (id, definicao) => invoke('servicos_atualizar', { id, definicao }),
    remove: (id) => invoke('servicos_remover', { id }),
    start: (id) => invoke('servicos_iniciar', { id }),
    stop: (id) => invoke('servicos_parar', { id }),
    restart: (id) => invoke('servicos_reiniciar', { id }),
    logs: (id) => invoke('servicos_logs', { id }),
    clearLogs: (id) => invoke('servicos_limpar_logs', { id }),
  },
  settings: {
    get: () => invoke('config_obter'),
    set: (chave, valor) => invoke('config_definir', { chave, valor }),
  },
  discovery: {
    scan: () => invoke('descoberta_varredura'),
  },
  docker: {
    status: () => invoke('docker_status'),
    containers: () => invoke('docker_containers'),
  },
  servico: {
    list: () => invoke('servico_listar'),
  },
  node: {
    version: (caminho) => invoke('node_versao', { caminho }),
    discover: (diretorio) => invoke('node_descobrir', { diretorio }),
  },
  app: {
    relaunchElevated: () => invoke('app_reiniciar_como_admin'),
    isElevated: () => invoke('app_elevado'),
    hideWindow: () => invoke('app_esconder_janela'),
    autoStart: () => invoke('app_inicio_automatico'),
    setAutoStart: (enabled) => invoke('app_definir_inicio_automatico', { enabled }),
    info: () => invoke('app_info'),
  },
  on: {
    state: (cb) => onChannel('svc:state', cb),
    log: (cb) => onChannel('svc:log', cb),
    health: (cb) => onChannel('svc:health', cb),
    metrics: (cb) => onChannel('svc:metrics', cb),
    notice: (cb) => onChannel('svc:notice', cb),
    list: (cb) => onChannel('svc:list', cb),
  },
};

export { api };
export const usandoTauri = true;

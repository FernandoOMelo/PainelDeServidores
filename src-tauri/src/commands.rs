//! Comandos expostos a interface (a API do app).
//!
//! O contrato e o mesmo do painel em JavaScript: a interface chama
//! `invoke('servicos_listar')` e recebe o mesmo formato de dado.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::autostart;
use crate::docker;
use crate::executables;
use crate::manager::Manager;
use crate::store::service_from_json;
use crate::types::{
    AppPaths, Container, HealthResult, HealthState, ListeningPort, LogEntry, Runtime, Service,
    WindowsService,
};

pub struct AppState {
    pub manager: Arc<Manager>,
    pub paths: AppPaths,
    pub app_root: PathBuf,
    pub window: parking_lot::Mutex<Option<tauri::WebviewWindow>>,
}

/* ------------------------------------------------------------------ */
/* Servicos                                                            */
/* ------------------------------------------------------------------ */

#[derive(Serialize)]
pub struct ServiceWithState {
    #[serde(flatten)]
    pub service: Service,
    pub state: Option<Runtime>,
}

#[tauri::command]
pub async fn servicos_listar(state: State<'_, AppState>) -> Result<Vec<ServiceWithState>, String> {
    let runtimes = state.manager.state().await;
    let services = state
        .manager
        .list()
        .into_iter()
        .map(|service| {
            let runtime = runtimes.get(&service.id).cloned();
            ServiceWithState { service, state: runtime }
        })
        .collect();
    Ok(services)
}

#[tauri::command]
pub async fn servicos_estado(state: State<'_, AppState>) -> Result<Vec<Runtime>, String> {
    let runtimes = state.manager.state().await;
    Ok(runtimes.into_values().collect())
}

#[tauri::command]
pub async fn servicos_criar(
    state: State<'_, AppState>,
    definicao: serde_json::Value,
) -> Result<Service, String> {
    let service = service_from_json(definicao);
    let created = state.manager.create(service).await?;
    state.manager.broadcast_list();
    Ok(created)
}

#[tauri::command]
pub async fn servicos_atualizar(
    state: State<'_, AppState>,
    id: String,
    definicao: serde_json::Value,
) -> Result<Service, String> {
    let service = service_from_json(definicao);
    let updated = state.manager.update(&id, service).await?;
    state.manager.broadcast_list();
    Ok(updated)
}

#[tauri::command]
pub async fn servicos_remover(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    state.manager.remove(&id);
    state.manager.broadcast_list();
    Ok(true)
}

#[tauri::command]
pub async fn servicos_iniciar(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    state.manager.start(&id).await;
    Ok(true)
}

#[tauri::command]
pub async fn servicos_parar(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    state.manager.stop(&id).await;
    Ok(true)
}

#[tauri::command]
pub async fn servicos_reiniciar(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    state.manager.restart(&id).await;
    Ok(true)
}

#[tauri::command]
pub async fn servicos_logs(state: State<'_, AppState>, id: String) -> Result<Vec<LogEntry>, String> {
    Ok(state.manager.logs(&id).await)
}

#[tauri::command]
pub async fn servicos_limpar_logs(
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    state.manager.clear_logs(&id).await;
    Ok(true)
}

/* ------------------------------------------------------------------ */
/* Configuracao                                                         */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub async fn config_obter(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let settings = state.manager.store().settings();
    Ok(serde_json::json!({
        "logBufferLines": settings.log_buffer_lines,
        "metricsIntervalMs": settings.metrics_interval_ms,
        "autoStart": settings.auto_start,
    }))
}

#[tauri::command]
pub async fn config_definir(
    state: State<'_, AppState>,
    chave: String,
    valor: serde_json::Value,
) -> Result<bool, String> {
    state.manager.store().set_setting(&chave, &valor);
    Ok(true)
}

/* ------------------------------------------------------------------ */
/* Descoberta                                                          */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub async fn descoberta_varredura() -> Result<Vec<ListeningPort>, String> {
    Ok(crate::discovery::listening_ports())
}

/* ------------------------------------------------------------------ */
/* Docker                                                              */
/* ------------------------------------------------------------------ */

#[derive(Serialize)]
pub struct DockerStatus {
    pub ok: bool,
    pub version: String,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn docker_status() -> Result<DockerStatus, String> {
    let (ok, version) = docker::availability().await;
    Ok(DockerStatus {
        ok,
        version: if ok { version.clone() } else { String::new() },
        error: if ok { None } else { Some(version) },
    })
}

#[tauri::command]
pub async fn docker_containers() -> Result<Vec<Container>, String> {
    crate::manager::docker_containers().await
}

/* ------------------------------------------------------------------ */
/* Servicos do Windows                                                 */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub async fn servico_listar() -> Result<Vec<WindowsService>, String> {
    Ok(crate::manager::windows_services())
}

/* ------------------------------------------------------------------ */
/* Node                                                                */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub async fn node_versao(
    state: State<'_, AppState>,
    caminho: String,
) -> Result<Option<String>, String> {
    let Some(resolved) = executables::resolve_node_executable(&caminho, &state.app_root) else {
        return Ok(None);
    };
    Ok(executables::detect_node_version(&resolved))
}

#[tauri::command]
pub async fn node_descobrir(
    state: State<'_, AppState>,
    diretorio: String,
) -> Result<Vec<executables::EmbeddedNode>, String> {
    let path = if diretorio.trim().is_empty() {
        state.app_root.clone()
    } else {
        PathBuf::from(diretorio)
    };
    Ok(executables::find_embedded_nodes(&path))
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub async fn app_reiniciar_como_admin() -> Result<bool, String> {
    Ok(autostart::relaunch_elevated())
}

#[tauri::command]
pub async fn app_elevado() -> Result<bool, String> {
    Ok(autostart::is_elevated())
}

#[tauri::command]
pub async fn app_esconder_janela(state: State<'_, AppState>) -> Result<bool, String> {
    if let Some(window) = state.window.lock().as_ref() {
        let _ = window.hide();
    }
    let manager = state.manager.clone();
    tauri::async_runtime::spawn(async move {
        manager.set_window_active(false).await;
    });
    Ok(true)
}

#[tauri::command]
pub async fn app_inicio_automatico() -> Result<bool, String> {
    Ok(autostart::is_enabled())
}

#[tauri::command]
pub async fn app_definir_inicio_automatico(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<bool, String> {
    let active = autostart::set_enabled(enabled);
    state.manager.store().set_setting("autoStart", &serde_json::Value::Bool(active));
    Ok(active)
}

#[tauri::command]
pub async fn app_info(state: State<'_, AppState>) -> Result<AppPaths, String> {
    Ok(state.paths.clone())
}

/* ------------------------------------------------------------------ */
/* Saude                                                               */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub async fn servico_verificar_saude(
    state: State<'_, AppState>,
    id: String,
) -> Result<HealthResult, String> {
    state.manager.check_health(&id).await;
    Ok(HealthResult {
        ok: true,
        state: HealthState::Unknown,
        latency_ms: 0,
        error: None,
        status: None,
        owner: None,
    })
}

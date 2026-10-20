//! Orquestrador: mantem os runners, a coleta de metricas e o roteamento
//! de eventos para a interface.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tauri::Emitter;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::sync::Mutex as AsyncMutex;

use crate::docker;
use crate::metrics::MetricsCollector;
use crate::service::{LogBuffer, Runner};
use crate::store::Store;
use crate::types::{AppEvent, HealthKind, Metric, Runtime, Service, ServiceKind};
use crate::winsvc;

pub struct Manager {
    store: Arc<Store>,
    runners: Mutex<HashMap<String, Arc<AsyncMutex<Runner>>>>,
    metrics: Mutex<MetricsCollector>,
    tx: UnboundedSender<AppEvent>,
    app_root: PathBuf,
    log_limit: usize,
    window_active: Mutex<bool>,
}

impl Manager {
    pub fn new(store: Arc<Store>, app_root: PathBuf, tx: UnboundedSender<AppEvent>) -> Self {
        let log_limit = store.settings().log_buffer_lines;
        Self {
            store,
            runners: Mutex::new(HashMap::new()),
            metrics: Mutex::new(MetricsCollector::new()),
            tx,
            app_root,
            log_limit,
            window_active: Mutex::new(false),
        }
    }

    pub fn store(&self) -> &Arc<Store> {
        &self.store
    }

    /* ------------------------------------------------------------------ */
    /* Servicos                                                           */
    /* ------------------------------------------------------------------ */

    pub fn list(&self) -> Vec<Service> {
        self.store.services()
    }

    pub async fn state(&self) -> HashMap<String, Runtime> {
        let mut out = HashMap::new();
        for (id, runner) in self.runner_list() {
            out.insert(id, runner.lock().await.snapshot());
        }
        out
    }

    pub fn service(&self, id: &str) -> Option<Service> {
        self.store.service(id)
    }

    pub async fn create(&self, service: Service) -> Result<Service, String> {
        if service.kind == ServiceKind::Docker && service.container.trim().is_empty() {
            return Err("Informe o nome do container Docker.".into());
        }
        if service.kind == ServiceKind::Servico && service.service.trim().is_empty() {
            return Err("Selecione o servico do Windows.".into());
        }

        self.store.add_service(service.clone());
        self.attach(service.clone()).await;
        Ok(service)
    }

    pub async fn update(&self, id: &str, service: Service) -> Result<Service, String> {
        if service.kind == ServiceKind::Docker && service.container.trim().is_empty() {
            return Err("Informe o nome do container Docker.".into());
        }
        if service.kind == ServiceKind::Servico && service.service.trim().is_empty() {
            return Err("Selecione o servico do Windows.".into());
        }

        let was_running = match self.runner(id) {
            Some(runner) => runner.lock().await.state == crate::types::RunnerState::Running,
            None => false,
        };

        self.store.update_service(id, service.clone());
        self.attach(service.clone()).await;

        if was_running {
            if let Some(runner) = self.runner(id) {
                let mut runner = runner.lock().await;
                runner.start().await;
            }
        }
        Ok(service)
    }

    pub fn remove(&self, id: &str) {
        self.store.remove_service(id);
        self.runners.lock().remove(id);
    }

    /// Cria (ou recria) o runner de um servico.
    async fn attach(&self, service: Service) {
        let logs = Arc::new(Mutex::new(LogBuffer {
            entries: Default::default(),
            seq: 0,
            limit: self.log_limit,
        }));
        let runner = Runner::new(service, self.app_root.clone(), logs, self.tx.clone());

        let runner = Arc::new(AsyncMutex::new(runner));
        let service_id = runner.lock().await.service.id.clone();
        self.runners.lock().insert(service_id, runner.clone());
    }

    fn runner(&self, id: &str) -> Option<Arc<AsyncMutex<Runner>>> {
        self.runners.lock().get(id).cloned()
    }

    /// Copia da lista de runners (evita segurar o lock do mapa).
    fn runner_list(&self) -> Vec<(String, Arc<AsyncMutex<Runner>>)> {
        self.runners
            .lock()
            .iter()
            .map(|(id, runner)| (id.clone(), runner.clone()))
            .collect()
    }

    pub async fn start(&self, id: &str) {
        let service = self.service(id);
        if service.as_ref().map(|s| s.monitor_only).unwrap_or(false) {
            return;
        }
        if let Some(runner) = self.runner(id) {
            let mut runner = runner.lock().await;
            runner.start().await;
        }
    }

    pub async fn stop(&self, id: &str) {
        let service = self.service(id);
        if service.as_ref().map(|s| s.monitor_only).unwrap_or(false) {
            return;
        }
        if let Some(runner) = self.runner(id) {
            let mut runner = runner.lock().await;
            runner.stop().await;
        }
    }

    pub async fn restart(&self, id: &str) {
        let service = self.service(id);
        if service.as_ref().map(|s| s.monitor_only).unwrap_or(false) {
            return;
        }
        if let Some(runner) = self.runner(id) {
            let mut runner = runner.lock().await;
            runner.restart().await;
        }
    }

    pub async fn logs(&self, id: &str) -> Vec<crate::types::LogEntry> {
        match self.runner(id) {
            Some(runner) => runner.lock().await.log_entries(),
            None => Vec::new(),
        }
    }

    pub async fn clear_logs(&self, id: &str) {
        if let Some(runner) = self.runner(id) {
            runner.lock().await.clear_logs();
        }
    }

    /* ------------------------------------------------------------------ */
    /* Janela e coletores                                                  */
    /* ------------------------------------------------------------------ */

    /// A interface abriu ou fechou. As metricas so sao coletadas com a
    /// janela aberta: elas existem para alimentar a tela.
    pub async fn set_window_active(&self, active: bool) {
        *self.window_active.lock() = active;

        for runner in self.runner_list() {
            let mut runner = runner.1.lock().await;
            runner.display_mode = active;
        }
    }

    pub fn window_active(&self) -> bool {
        *self.window_active.lock()
    }

    /// Amostra as metricas: processos locais pela API do Windows e
    /// containers pela API do Docker.
    pub async fn sample_metrics(&self) -> Vec<Metric> {
        let mut pids: Vec<(String, u32)> = Vec::new();
        let mut containers: Vec<(String, String)> = Vec::new();

        for (id, runner) in self.runner_list() {
            let runner = runner.lock().await;
            if let Some(pid) = runner.pid {
                pids.push((id.clone(), pid));
            }
            if runner.service.kind == ServiceKind::Docker {
                containers.push((id, runner.service.container.clone()));
            }
        }

        let mut out = Vec::new();

        if !pids.is_empty() {
            let only: Vec<u32> = pids.iter().map(|(_, pid)| *pid).collect();
            let samples = self.metrics.lock().sample(&only);
            for sample in samples {
                if let Some((id, _)) = pids.iter().find(|(_, pid)| *pid == sample.pid) {
                    out.push(Metric {
                        id: id.clone(),
                        pid: sample.pid,
                        cpu: sample.cpu_percent,
                        mem: sample.mem_mb,
                    });
                }
            }
        }

        for (id, container) in containers {
            if let Ok(stats) = docker::stats(&container).await {
                out.push(Metric {
                    id,
                    pid: 0,
                    cpu: stats.cpu,
                    mem: stats.mem,
                });
            }
        }

        out
    }

    /// Executa a verificacao de saude de um servico.
    pub async fn check_health(&self, id: &str) {
        let Some(runner) = self.runner(id) else { return };
        let config = {
            let runner = runner.lock().await;
            runner.service.health.clone()
        };
        if config.kind == HealthKind::None {
            return;
        }

        let result = crate::health::check(&config).await;
        if let Some(runner) = self.runner(id) {
            let mut runner = runner.lock().await;
            runner.health = result.state;
            runner.health_detail = Some(crate::health::detail(&result));
        }
        let _ = self.tx.send(AppEvent::Health {
            id: id.to_string(),
            result,
        });
    }

    /// Publica a lista de servicos.
    pub fn broadcast_list(&self) {
        let _ = self.tx.send(AppEvent::List(self.list()));
    }

    /* ------------------------------------------------------------------ */
    /* Ciclo de vida do app                                                */
    /* ------------------------------------------------------------------ */

    /// Registra os servicos vindos do config e comeca a acompanhar.
    pub async fn init(&self) {
        for service in self.list() {
            self.attach(service).await;
        }

        for service in self.list() {
            let Some(runner) = self.runner(&service.id) else {
                continue;
            };
            let mut runner = runner.lock().await;
            if service.monitor_only {
                runner.observe();
            } else {
                runner.monitor();
                if service.autostart {
                    runner.start().await;
                }
            }
        }
    }

    /// Encerra o app: para os processos que ele iniciou.
    pub async fn shutdown(&self) {
        for (_, runner) in self.runner_list() {
            let mut runner = runner.lock().await;
            if runner.pid.is_some() {
                runner.stop().await;
            }
        }
    }
}

/// Trata os eventos internos (estado de container/servico, queda de processo)
/// e os repassa para a interface.
pub async fn pump_events(
    mut rx: UnboundedReceiver<AppEvent>,
    manager: Arc<Manager>,
    app: tauri::AppHandle,
) {
    while let Some(event) = rx.recv().await {
        match &event {
            AppEvent::DockerState { id, info } => {
                if let Some(runner) = manager.runner(id) {
                    let mut runner = runner.lock().await;
                    runner.apply_docker_state(info.clone());
                }
            }
            AppEvent::WindowsState { id, info } => {
                if let Some(runner) = manager.runner(id) {
                    let mut runner = runner.lock().await;
                    runner.apply_windows_state(info.clone());
                }
            }
            AppEvent::Exited { id, code } => {
                if let Some(runner) = manager.runner(id) {
                    let mut runner = runner.lock().await;
                    runner.exit_code = *code;
                    if runner.state != crate::types::RunnerState::Stopping {
                        runner.state = crate::types::RunnerState::Crashed;
                        runner.push_log(
                            "system",
                            format!("Processo encerrado inesperadamente (codigo {code:?})."),
                        );
                        let reason = format!("processo encerrado (codigo {code:?})");
                        runner.schedule_restart(reason);
                    }
                    runner.emit_state();
                }
            }
            AppEvent::Version { path, version } => {
                for (_, runner) in manager.runner_list() {
                    let matches = runner.lock().await.node_path.as_deref() == Some(path.as_str());
                    if matches {
                        let mut runner = runner.lock().await;
                        runner.node_version = version.clone();
                        runner.emit_state();
                    }
                }
            }
            _ => {}
        }

        if let Err(err) = app.emit("painel-evento", event) {
            eprintln!("[pump] erro ao emitir: {err}");
        }
    }
}

/// Dispara a coleta de metricas enquanto a interface estiver aberta.
pub async fn metrics_loop(manager: Arc<Manager>, app: tauri::AppHandle) {
    let mut ticker = tokio::time::interval(Duration::from_millis(2000));
    loop {
        ticker.tick().await;
        if !manager.window_active() {
            continue;
        }
        let metrics = manager.sample_metrics().await;
        if !metrics.is_empty() {
            let _ = app.emit("painel-evento", AppEvent::Metrics(metrics));
        }
    }
}

/// Containers do Docker, expostos a interface.
pub async fn docker_containers() -> Result<Vec<crate::types::Container>, String> {
    let rows = docker::list_containers().await?;
    Ok(rows
        .into_iter()
        .map(|row| crate::types::Container {
            id: row.id,
            name: row.name,
            image: row.image,
            state: row.state,
            status: row.status,
            ports: row.ports,
            created_at: row.created_at,
        })
        .collect())
}

/// Servicos do Windows, expostos a interface.
pub fn windows_services() -> Vec<crate::types::WindowsService> {
    winsvc::list()
}

/// Cria o canal de eventos e o gerenciador.
pub fn create_manager(
    store: Arc<Store>,
    app_root: PathBuf,
) -> (Arc<Manager>, UnboundedReceiver<AppEvent>) {
    let (tx, rx) = unbounded_channel();
    let manager = Arc::new(Manager::new(store, app_root, tx.clone()));
    (manager, rx)
}

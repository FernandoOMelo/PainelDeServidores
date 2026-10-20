//! Runner de servico: unifica processo local, container Docker e servico
//! do Windows sob a mesma interface (start/stop/restart/monitor/logs).

use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::process::{Child, Command};
use tokio::sync::mpsc::UnboundedSender;

use crate::docker;
use crate::executables;
use crate::types::{
    AppEvent, HealthDetail, HealthState, LogEntry, PortInfo, RunnerState, Runtime, Service,
    ServiceKind,
};
use crate::winsvc;

/// Buffer circular de logs (em memoria).
#[derive(Default)]
pub struct LogBuffer {
    pub entries: VecDeque<LogEntry>,
    pub seq: u64,
    pub limit: usize,
}

impl LogBuffer {
    pub fn push(&mut self, stream: &str, text: String) -> Vec<LogEntry> {
        self.seq += 1;
        let entry = LogEntry {
            ts: now_millis(),
            stream: stream.to_string(),
            text,
            seq: self.seq,
        };
        self.entries.push_back(entry.clone());
        while self.entries.len() > self.limit {
            self.entries.pop_front();
        }
        vec![entry]
    }
}

pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Controla um servico cadastrado.
pub struct Runner {
    pub service: Service,
    pub state: RunnerState,
    pub pid: Option<u32>,
    pub service_state: Option<String>,
    pub image: Option<String>,
    pub ports: Vec<PortInfo>,
    pub health: HealthState,
    pub health_detail: Option<HealthDetail>,
    pub exit_code: Option<i32>,
    pub started_at: Option<i64>,
    pub restart_count: u32,
    pub next_retry_at: Option<i64>,
    pub last_error: Option<String>,
    pub node_path: Option<String>,
    pub node_version: Option<String>,
    pub start_mode: Option<String>,
    /// Somente leitura: o painel nao inicia nem para.
    pub observed: bool,
    /// A interface esta aberta (colectores de exibicao podem rodar).
    pub display_mode: bool,
    pub app_root: PathBuf,
    pub logs: Arc<Mutex<LogBuffer>>,
    pub tx: UnboundedSender<AppEvent>,
    child: Option<Child>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    monitor_started: bool,
}

impl Runner {
    pub fn new(
        service: Service,
        app_root: PathBuf,
        logs: Arc<Mutex<LogBuffer>>,
        tx: UnboundedSender<AppEvent>,
    ) -> Self {
        Self {
            service,
            state: RunnerState::Stopped,
            pid: None,
            service_state: None,
            image: None,
            ports: Vec::new(),
            health: HealthState::Unknown,
            health_detail: None,
            exit_code: None,
            started_at: None,
            restart_count: 0,
            next_retry_at: None,
            last_error: None,
            node_path: None,
            node_version: None,
            start_mode: None,
            observed: false,
            display_mode: false,
            app_root,
            logs,
            tx,
            child: None,
            tasks: Vec::new(),
            monitor_started: false,
        }
    }

    pub fn snapshot(&self) -> Runtime {
        Runtime {
            id: self.service.id.clone(),
            state: self.state,
            kind: self.service.kind,
            pid: self.pid,
            service: match self.service.kind {
                ServiceKind::Servico => Some(self.service.service.clone()),
                _ => None,
            },
            service_state: self.service_state.clone(),
            image: self.image.clone(),
            ports: self.ports.clone(),
            health: self.health,
            health_detail: self.health_detail.clone(),
            exit_code: self.exit_code,
            started_at: self.started_at,
            uptime_ms: self
                .started_at
                .map(|started| (now_millis() - started).max(0) as u64)
                .unwrap_or(0),
            restart_count: self.restart_count,
            next_retry_at: self.next_retry_at,
            last_error: self.last_error.clone(),
            node_path: self.node_path.clone(),
            node_version: self.node_version.clone(),
            start_mode: self.start_mode.clone(),
        }
    }

    pub fn emit_state(&self) {
        let _ = self.tx.send(AppEvent::State(self.snapshot()));
    }

    pub fn push_log(&self, stream: &str, text: String) {
        let entries = {
            let mut buffer = self.logs.lock();
            buffer.push(stream, text)
        };
        if !entries.is_empty() {
            let _ = self.tx.send(AppEvent::Log {
                id: self.service.id.clone(),
                entries,
            });
        }
    }

    fn notice(&self, message: String, level: &str, needs_elevation: bool) {
        let _ = self.tx.send(AppEvent::Notice(crate::types::Notice {
            title: Some(self.service.name.clone()),
            message,
            level: level.to_string(),
            needs_elevation,
        }));
    }

    /* ------------------------------------------------------------------ */
    /* Ciclo de vida                                                       */
    /* ------------------------------------------------------------------ */

    pub async fn start(&mut self) {
        if self.observed {
            self.push_log(
                "system",
                "Servico somente monitorar: iniciar/parar esta desativado.".into(),
            );
            return;
        }
        if matches!(self.state, RunnerState::Running | RunnerState::Starting) {
            return;
        }

        self.last_error = None;
        self.state = RunnerState::Starting;
        self.emit_state();

        match self.service.kind {
            ServiceKind::Processo => self.start_process().await,
            ServiceKind::Docker => self.start_docker().await,
            ServiceKind::Servico => self.start_windows_service().await,
        }
    }

    async fn start_process(&mut self) {
        let execution = executables::resolve_execution(
            &self.service.command,
            &self.service.args,
            &self.service.node_path,
            &self.app_root,
        );

        if let Some(warning) = &execution.warning {
            self.push_log("system", warning.clone());
        }
        self.node_path = execution
            .node_path
            .as_ref()
            .map(|p| p.to_string_lossy().to_string());
        if let Some(path) = &execution.node_path {
            let path = path.clone();
            let version = executables::detect_node_version(&path);
            self.node_version = version;
            self.emit_state();
        }

        // Diretorio de trabalho: caminho relativo e ancorado na pasta do app.
        let cwd = self.resolve_cwd();
        let mut command = Command::new(&execution.command);
        command
            .args(&execution.args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        for (key, value) in &execution.env {
            command.env(key, value);
        }
        for (key, value) in &self.service.env {
            command.env(key, value);
        }
        command.env("FORCE_COLOR", "1");

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(err) => {
                self.state = RunnerState::Crashed;
                self.last_error = Some(err.to_string());
                self.push_log("system", format!("ERRO ao iniciar: {err}"));
                self.emit_state();
                return;
            }
        };

        let command_line = {
            let mut parts = vec![execution.command.clone()];
            parts.extend(execution.args.iter().cloned());
            parts.join(" ")
        };

        self.pid = child.id();
        self.state = RunnerState::Running;
        self.started_at = Some(now_millis());
        self.exit_code = None;
        self.push_log(
            "system",
            format!("Iniciado: {command_line}"),
        );
        self.emit_state();

        self.spawn_pipe_reader(child.stdout.take(), "stdout");
        self.spawn_pipe_reader(child.stderr.take(), "stderr");

        let id = self.service.id.clone();
        let tx = self.tx.clone();
        let logs = self.logs.clone();
        let mut handle = child;

        // Acompanha a saida do processo para detectar quedas.
        self.tasks.push(tokio::spawn(async move {
            let status = handle.wait().await;
            let code = status.ok().and_then(|s| s.code());
            let mut buffer = logs.lock();
            buffer.push(
                "system",
                match code {
                    Some(code) => format!("Processo encerrado (codigo {code})."),
                    None => "Processo encerrado.".into(),
                },
            );
            drop(buffer);
            let _ = tx.send(AppEvent::Exited { id, code });
        }));

        self.child = None; // o processo ja esta sendo acompanhado pela task
    }

    fn spawn_pipe_reader<R>(&mut self, pipe: Option<R>, stream: &'static str)
    where
        R: tokio::io::AsyncRead + Unpin + Send + 'static,
    {
        let Some(mut pipe) = pipe else { return };
        let logs = self.logs.clone();
        let tx = self.tx.clone();
        let id = self.service.id.clone();

        self.tasks.push(tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(pipe).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.is_empty() {
                    continue;
                }
                let mut buffer = logs.lock();
                let entries = buffer.push(stream, line);
                drop(buffer);
                let _ = tx.send(AppEvent::Log { id: id.clone(), entries });
            }
        }));
    }

    async fn start_docker(&mut self) {
        let container = self.service.container.clone();
        if let Err(err) = docker::start(&container).await {
            self.state = RunnerState::Crashed;
            self.last_error = Some(err.clone());
            self.push_log("system", format!("ERRO ao iniciar container: {err}"));
            self.emit_state();
            return;
        }

        self.push_log("system", format!("Container \"{container}\" iniciado."));
        self.state = RunnerState::Running;
        self.started_at = Some(now_millis());
        self.emit_state();
        self.spawn_docker_logs();
    }

    /// Stream de logs do container.
    ///
    /// Usa o `docker logs -f` (que fala com o pipe em modo overlapped) em vez
    /// da API: o pipe aceita um cliente por vez em modo byte, e um stream
    /// longo bloquearia as consultas de estado.
    fn spawn_docker_logs(&mut self) {
        let container = self.service.container.clone();
        let logs = self.logs.clone();
        let tx = self.tx.clone();
        let id = self.service.id.clone();

        self.tasks.push(tokio::spawn(async move {
            let mut child = match tokio::process::Command::new("docker")
                .args(["logs", "--tail", "200", "-f", &container])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true)
                .spawn()
            {
                Ok(child) => child,
                Err(err) => {
                    eprintln!("[logs] falha ao abrir o stream de {container}: {err}");
                    return;
                }
            };

            use tokio::io::{AsyncBufReadExt, BufReader};

            let stdout = child.stdout.take();
            let stderr = child.stderr.take();

            async fn ler<R>(
                reader: Option<R>,
                stream: &'static str,
                logs: Arc<Mutex<LogBuffer>>,
                tx: UnboundedSender<AppEvent>,
                id: String,
            ) where
                R: tokio::io::AsyncRead + Unpin + Send + 'static,
            {
                let Some(reader) = reader else { return };
                let mut lines = BufReader::new(reader).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if line.is_empty() {
                        continue;
                    }
                    let entries = {
                        let mut buffer = logs.lock();
                        buffer.push(stream, line)
                    };
                    let _ = tx.send(AppEvent::Log { id: id.clone(), entries });
                }
            }

            tokio::join!(
                ler(stdout, "stdout", logs.clone(), tx.clone(), id.clone()),
                ler(stderr, "stderr", logs.clone(), tx.clone(), id.clone())
            );
        }));
    }

    async fn start_windows_service(&mut self) {
        let name = self.service.service.clone();
        let result = winsvc::start(&name);

        if !result.ok {
            self.state = RunnerState::Crashed;
            self.last_error = Some(result.message.clone());
            self.push_log("system", format!("ERRO ao iniciar: {}", result.message));
            self.notice(result.message, "error", result.needs_elevation);
            self.emit_state();
            return;
        }

        self.push_log("system", format!("Servico \"{name}\" iniciado."));
        self.state = RunnerState::Running;
        self.started_at = Some(now_millis());
        self.emit_state();
    }

    pub async fn stop(&mut self) {
        if self.observed {
            self.push_log(
                "system",
                "Servico somente monitorar: parar esta desativado.".into(),
            );
            return;
        }

        match self.service.kind {
            ServiceKind::Processo => self.stop_process().await,
            ServiceKind::Docker => {
                self.state = RunnerState::Stopping;
                self.emit_state();
                if let Err(err) = docker::stop(&self.service.container, 10).await {
                    self.last_error = Some(err.clone());
                    self.push_log("system", format!("ERRO ao parar: {err}"));
                    self.state = RunnerState::Crashed;
                    self.emit_state();
                    return;
                }
                self.push_log(
                    "system",
                    format!("Container \"{}\" encerrado.", self.service.container),
                );
                self.state = RunnerState::Stopped;
                self.started_at = None;
                self.emit_state();
            }
            ServiceKind::Servico => {
                self.state = RunnerState::Stopping;
                self.emit_state();
                let result = winsvc::stop(&self.service.service);
                if !result.ok {
                    self.last_error = Some(result.message.clone());
                    self.push_log("system", format!("ERRO ao parar: {}", result.message));
                    self.state = RunnerState::Crashed;
                    self.emit_state();
                    self.notice(result.message, "error", result.needs_elevation);
                    return;
                }
                self.push_log(
                    "system",
                    format!("Servico \"{}\" encerrado.", self.service.service),
                );
                self.state = RunnerState::Stopped;
                self.started_at = None;
                self.emit_state();
            }
        }
    }

    async fn stop_process(&mut self) {
        let Some(pid) = self.pid else {
            self.state = RunnerState::Stopped;
            self.emit_state();
            return;
        };

        self.state = RunnerState::Stopping;
        self.emit_state();

        // Encerra a arvore de processos (no Windows, com taskkill).
        kill_tree(pid).await;

        self.pid = None;
        self.started_at = None;
        self.state = RunnerState::Stopped;
        self.push_log("system", "Parado pelo usuario.".into());
        self.emit_state();
    }

    pub async fn restart(&mut self) {
        if self.observed {
            return;
        }
        match self.service.kind {
            ServiceKind::Processo => {
                self.stop_process().await;
                self.start().await;
            }
            ServiceKind::Docker => {
                self.state = RunnerState::Stopping;
                self.emit_state();
                if let Err(err) = docker::restart(&self.service.container, 10).await {
                    self.last_error = Some(err.clone());
                    self.push_log("system", format!("ERRO ao reiniciar: {err}"));
                    self.state = RunnerState::Crashed;
                    self.emit_state();
                    return;
                }
                self.push_log(
                    "system",
                    format!("Container \"{}\" reiniciado.", self.service.container),
                );
                self.state = RunnerState::Running;
                self.started_at = Some(now_millis());
                self.emit_state();
            }
            ServiceKind::Servico => {
                self.state = RunnerState::Stopping;
                self.emit_state();
                let result = winsvc::restart(&self.service.service);
                if !result.ok {
                    self.last_error = Some(result.message.clone());
                    self.push_log("system", format!("ERRO ao reiniciar: {}", result.message));
                    self.state = RunnerState::Crashed;
                    self.emit_state();
                    self.notice(result.message, "error", result.needs_elevation);
                    return;
                }
                self.push_log(
                    "system",
                    format!("Servico \"{}\" reiniciado.", self.service.service),
                );
                self.state = RunnerState::Running;
                self.started_at = Some(now_millis());
                self.emit_state();
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* Monitoramento                                                       */
    /* ------------------------------------------------------------------ */

    /// Acompanha sem controlar (modo somente monitorar).
    pub fn observe(&mut self) {
        self.observed = true;
        self.spawn_monitor();
    }

    /// Acompanha o estado real do servico.
    pub fn monitor(&mut self) {
        self.spawn_monitor();
    }

    fn spawn_monitor(&mut self) {
        if self.monitor_started {
            return;
        }
        self.monitor_started = true;
        let id = self.service.id.clone();
        let kind = self.service.kind;
        let container = self.service.container.clone();
        let service_name = self.service.service.clone();
        let tx = self.tx.clone();
        let interval = Duration::from_millis(self.service.health.interval_ms.max(1000));

        self.tasks.push(tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            loop {
                ticker.tick().await;

                match kind {
                    ServiceKind::Docker => match docker::inspect(&container).await {
                        Ok(info) => {
                            let _ = tx.send(AppEvent::DockerState { id: id.clone(), info });
                        }
                        Err(err) => eprintln!("[monitor] inspect de {container} falhou: {err}"),
                    },
                    ServiceKind::Servico => {
                        if let Some(info) = winsvc::query(&service_name) {
                            let _ = tx.send(AppEvent::WindowsState { id: id.clone(), info });
                        }
                    }
                    ServiceKind::Processo => {}
                }
            }
        }));
    }

    /// Aplica o estado de um container lido pela API.
    pub fn apply_docker_state(&mut self, info: docker::InspectInfo) {
        self.image = Some(info.image.clone());
        self.ports = info
            .ports
            .iter()
            .map(|p| PortInfo {
                port: p.port.clone(),
                published: p.published.clone(),
                host: p.host.clone(),
            })
            .collect();
        self.exit_code = Some(info.exit_code);
        self.service_state = Some(info.state.clone());

        let previous = self.state;
        self.state = match info.state.as_str() {
            "running" => RunnerState::Running,
            "paused" => RunnerState::Paused,
            "restarting" => RunnerState::Backoff,
            "exited" | "created" | "dead" => RunnerState::Stopped,
            _ => RunnerState::Stopped,
        };

        if self.state == RunnerState::Running {
            self.started_at = Some(now_millis());
            self.pid = None;
        } else {
            self.started_at = None;
        }

        // A saude do container vem do HEALTHCHECK proprio do Docker.
        if self.service.health.kind == crate::types::HealthKind::None {
            let health = match info.health.as_deref() {
                Some("healthy") => HealthState::Healthy,
                Some("unhealthy") => HealthState::Unhealthy,
                _ => HealthState::Unknown,
            };
            if health != self.health {
                self.health = health;
                let _ = self.tx.send(AppEvent::Health {
                    id: self.service.id.clone(),
                    result: crate::types::HealthResult {
                        ok: health == HealthState::Healthy,
                        state: health,
                        latency_ms: 0,
                        error: info.health_log.clone(),
                        status: info.health.clone(),
                        owner: None,
                    },
                });
            }
            self.health_detail = Some(HealthDetail {
                latency_ms: 0,
                error: info.health_log.clone(),
                status: info.health.clone(),
                owner: None,
            });
        }

        // Saiu sozinho: o reinicio automatico assume daqui.
        if !self.observed
            && matches!(previous, RunnerState::Running)
            && matches!(self.state, RunnerState::Stopped)
        {
            self.push_log(
                "system",
                format!("Container parou sozinho (exit {}).", info.exit_code),
            );
            self.schedule_restart(format!("container parou com codigo {}", info.exit_code));
        }

        self.emit_state();
    }

    /// Aplica o estado de um servico do Windows.
    pub fn apply_windows_state(&mut self, info: winsvc::ServiceStatus) {
        self.service_state = Some(info.state.clone());
        self.start_mode = Some(info.start_mode.clone());
        self.pid = info.pid;
        self.exit_code = None;

        let previous = self.state;
        self.state = match info.state_number {
            4 => RunnerState::Running,
            7 => RunnerState::Paused,
            2 => RunnerState::Starting,
            3 => RunnerState::Stopping,
            1 => RunnerState::Stopped,
            _ => RunnerState::Stopped,
        };

        if self.state == RunnerState::Running {
            self.started_at = Some(now_millis());
        } else {
            self.started_at = None;
        }

        if self.service.health.kind == crate::types::HealthKind::None {
            let health = match self.state {
                RunnerState::Running => HealthState::Healthy,
                RunnerState::Stopped => HealthState::Unhealthy,
                _ => HealthState::Unknown,
            };
            if health != self.health {
                self.health = health;
                let _ = self.tx.send(AppEvent::Health {
                    id: self.service.id.clone(),
                    result: crate::types::HealthResult {
                        ok: health == HealthState::Healthy,
                        state: health,
                        latency_ms: 0,
                        error: None,
                        status: Some(info.state.clone()),
                        owner: None,
                    },
                });
            }
        }

        if !self.observed
            && matches!(previous, RunnerState::Running)
            && matches!(self.state, RunnerState::Stopped)
        {
            self.push_log("system", "Servico parou sozinho.".into());
            self.schedule_restart("servico parou".into());
        }

        self.emit_state();
    }

    /// Agenda um reinicio com backoff exponencial.
    pub fn schedule_restart(&mut self, reason: String) {
        let config = self.service.restart.clone();
        if !config.enabled {
            self.state = RunnerState::Crashed;
            self.last_error = Some(reason);
            self.emit_state();
            return;
        }
        if self.restart_count >= config.max_retries {
            self.state = RunnerState::Crashed;
            self.last_error = Some(format!(
                "Limite de {} reinicios excedido ({reason})",
                config.max_retries
            ));
            self.push_log("system", self.last_error.clone().unwrap_or_default());
            self.emit_state();
            return;
        }

        self.restart_count += 1;
        let delay = config
            .backoff_ms
            .saturating_mul(1u64 << (self.restart_count - 1).min(16))
            .min(config.max_backoff_ms);
        self.next_retry_at = Some(now_millis() + delay as i64);
        self.state = RunnerState::Backoff;
        self.last_error = Some(reason);
        self.push_log(
            "system",
            format!(
                "Reiniciando em {}s (tentativa {}/{}).",
                delay / 1000,
                self.restart_count,
                config.max_retries
            ),
        );
        self.emit_state();
    }

    /* ------------------------------------------------------------------ */
    /* Logs                                                                */
    /* ------------------------------------------------------------------ */

    pub fn log_entries(&self) -> Vec<LogEntry> {
        self.logs.lock().entries.iter().cloned().collect()
    }

    pub fn clear_logs(&self) {
        self.logs.lock().entries.clear();
    }

    fn resolve_cwd(&self) -> PathBuf {
        let configured = self.service.cwd.trim();
        if configured.is_empty() {
            return self.app_root.clone();
        }
        let path = PathBuf::from(configured);
        let path = if path.is_absolute() {
            path
        } else {
            self.app_root.join(path)
        };
        if path.is_dir() {
            path
        } else {
            self.app_root.clone()
        }
    }
}

/// Encerra o processo e a arvore de filhos.
async fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill.exe")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(0x08000000)
            .output()
            .await;
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output()
            .await;
    }
}

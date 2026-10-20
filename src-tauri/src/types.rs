//! Tipos compartilhados entre o motor, os comandos e a interface.

use serde::{Deserialize, Serialize};

/// Tipo de servico gerenciado pelo painel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceKind {
    /// Processo local (node, python, dotnet...).
    Processo,
    /// Container Docker.
    Docker,
    /// Servico registrado no Windows (Service Control Manager).
    Servico,
}

impl ServiceKind {
    pub fn is_docker(&self) -> bool {
        matches!(self, ServiceKind::Docker)
    }

    pub fn is_windows_service(&self) -> bool {
        matches!(self, ServiceKind::Servico)
    }
}

/// Como verificar se um servico esta de pe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthKind {
    /// Sem verificacao: o status vem do proprio servico.
    None,
    /// A porta TCP esta aceitando conexao.
    Tcp,
    /// O endpoint responde com o status esperado.
    Http,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct HealthConfig {
    #[serde(rename = "type")]
    pub kind: HealthKind,
    pub port: Option<u16>,
    pub path: String,
    pub expect_status: u16,
    pub interval_ms: u64,
    pub timeout_ms: u64,
    pub grace_ms: u64,
    pub failures_before_unhealthy: u32,
}

impl Default for HealthConfig {
    fn default() -> Self {
        Self {
            kind: HealthKind::None,
            port: None,
            path: "/".into(),
            expect_status: 200,
            interval_ms: 5000,
            timeout_ms: 3000,
            grace_ms: 10000,
            failures_before_unhealthy: 3,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct RestartConfig {
    pub enabled: bool,
    pub max_retries: u32,
    pub backoff_ms: u64,
    pub max_backoff_ms: u64,
    pub restart_on_unhealthy: bool,
    pub stability_ms: u64,
}

impl Default for RestartConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_retries: 5,
            backoff_ms: 1000,
            max_backoff_ms: 30000,
            restart_on_unhealthy: true,
            stability_ms: 60000,
        }
    }
}

/// Um servico cadastrado no painel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub id: String,
    pub name: String,
    pub group: String,
    #[serde(rename = "type")]
    pub kind: ServiceKind,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: std::collections::BTreeMap<String, String>,
    pub shell: bool,
    pub autostart: bool,
    pub monitor_only: bool,
    /// Caminho do node.exe proprio deste servico.
    pub node_path: String,
    /// Container alvo (quando kind = Docker).
    pub container: String,
    /// Servico do Windows alvo (quando kind = Servico).
    pub service: String,
    pub health: HealthConfig,
    pub restart: RestartConfig,
    pub created_at: String,
}

impl Default for Service {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "Servidor".into(),
            group: "Geral".into(),
            kind: ServiceKind::Processo,
            command: String::new(),
            args: Vec::new(),
            cwd: String::new(),
            env: Default::default(),
            shell: false,
            autostart: false,
            monitor_only: false,
            node_path: String::new(),
            container: String::new(),
            service: String::new(),
            health: HealthConfig::default(),
            restart: RestartConfig::default(),
            created_at: String::new(),
        }
    }
}

/// Estado do processo/container/servico no painel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunnerState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Backoff,
    Crashed,
    Paused,
}

/// Situacao de saude.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthState {
    Unknown,
    Healthy,
    Unhealthy,
}

/// Quem responde na porta (evita o falso positivo de outro servico).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortOwner {
    pub process: String,
    pub pid: u32,
    pub address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthDetail {
    pub latency_ms: u64,
    pub error: Option<String>,
    pub status: Option<String>,
    pub owner: Option<PortOwner>,
}

/// Fotografia do runtime de um servico.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    pub id: String,
    pub state: RunnerState,
    #[serde(rename = "type")]
    pub kind: ServiceKind,
    pub pid: Option<u32>,
    pub service: Option<String>,
    pub service_state: Option<String>,
    pub image: Option<String>,
    pub ports: Vec<PortInfo>,
    pub health: HealthState,
    pub health_detail: Option<HealthDetail>,
    pub exit_code: Option<i32>,
    pub started_at: Option<i64>,
    pub uptime_ms: u64,
    pub restart_count: u32,
    pub next_retry_at: Option<i64>,
    pub last_error: Option<String>,
    pub node_path: Option<String>,
    pub node_version: Option<String>,
    pub start_mode: Option<String>,
}

impl Runtime {
    pub fn stopped(id: &str) -> Self {
        Self {
            id: id.to_string(),
            state: RunnerState::Stopped,
            kind: ServiceKind::Processo,
            pid: None,
            service: None,
            service_state: None,
            image: None,
            ports: Vec::new(),
            health: HealthState::Unknown,
            health_detail: None,
            exit_code: None,
            started_at: None,
            uptime_ms: 0,
            restart_count: 0,
            next_retry_at: None,
            last_error: None,
            node_path: None,
            node_version: None,
            start_mode: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub port: String,
    pub published: Option<String>,
    pub host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub ts: i64,
    pub stream: String,
    pub text: String,
    pub seq: u64,
}

/// Uma porta escutando na maquina.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListeningPort {
    pub pid: u32,
    pub port: u16,
    pub host: String,
    pub address: String,
    pub process: String,
}

/// Container Docker.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub ports: String,
    pub created_at: String,
}

/// Servico do Windows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsService {
    pub name: String,
    pub display_name: String,
    pub state: String,
    pub start_mode: String,
    pub pid: Option<u32>,
    pub path: String,
}

/// Resultado de uma verificacao de saude.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResult {
    pub ok: bool,
    pub state: HealthState,
    pub latency_ms: u64,
    pub error: Option<String>,
    pub status: Option<String>,
    pub owner: Option<PortOwner>,
}

/// Eventos empurrados para a interface.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "canal", content = "dados")]
pub enum AppEvent {
    #[serde(rename = "svc:state")]
    State(Runtime),
    #[serde(rename = "svc:log")]
    Log { id: String, entries: Vec<LogEntry> },
    #[serde(rename = "svc:health")]
    Health {
        id: String,
        #[serde(flatten)]
        result: HealthResult,
    },
    #[serde(rename = "svc:metrics")]
    Metrics(Vec<Metric>),
    #[serde(rename = "svc:notice")]
    Notice(Notice),
    #[serde(rename = "svc:list")]
    List(Vec<Service>),
    /// O processo local terminou (queda).
    #[serde(rename = "svc:exited")]
    Exited { id: String, code: Option<i32> },
    /// Versao do node de um servico.
    #[serde(rename = "svc:version")]
    Version { path: String, version: Option<String> },
    /// Estado de um container lido pela API do Docker.
    #[serde(rename = "svc:docker-state")]
    DockerState { id: String, info: crate::docker::InspectInfo },
    /// Estado de um servico do Windows.
    #[serde(rename = "svc:windows-state")]
    WindowsState { id: String, info: crate::winsvc::ServiceStatus },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metric {
    pub id: String,
    pub pid: u32,
    pub cpu: f64,
    pub mem: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub title: Option<String>,
    pub message: String,
    pub level: String,
    pub needs_elevation: bool,
}

/// Caminhos usados pelo app (config, logs, dados do usuario).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    pub config: String,
    pub logs: String,
    pub user_data: String,
}

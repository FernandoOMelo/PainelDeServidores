//! Persistencia da configuracao: leitura, normalizacao e escrita atomica.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::types::{HealthKind, Service, ServiceKind};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub log_buffer_lines: usize,
    pub metrics_interval_ms: u64,
    pub auto_start: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            log_buffer_lines: 2000,
            metrics_interval_ms: 2000,
            auto_start: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub version: u32,
    pub settings: Settings,
    pub services: Vec<Service>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: 1,
            settings: Settings::default(),
            services: Vec::new(),
        }
    }
}

/// Arquivo de configuracao do painel.
pub struct Store {
    path: PathBuf,
    data: parking_lot::RwLock<Config>,
}

impl Store {
    pub fn new(path: &Path) -> Self {
        let data = read_config(path);
        Self {
            path: path.to_path_buf(),
            data: parking_lot::RwLock::new(data),
        }
    }

    pub fn services(&self) -> Vec<Service> {
        self.data.read().services.clone()
    }

    pub fn service(&self, id: &str) -> Option<Service> {
        self.data.read().services.iter().find(|s| s.id == id).cloned()
    }

    pub fn settings(&self) -> Settings {
        self.data.read().settings.clone()
    }

    pub fn set_setting(&self, key: &str, value: &serde_json::Value) {
        {
            let mut data = self.data.write();
            match key {
                "logBufferLines" => {
                    if let Some(v) = value.as_u64() {
                        data.settings.log_buffer_lines = v as usize;
                    }
                }
                "metricsIntervalMs" => {
                    if let Some(v) = value.as_u64() {
                        data.settings.metrics_interval_ms = v;
                    }
                }
                "autoStart" => {
                    if let Some(v) = value.as_bool() {
                        data.settings.auto_start = v;
                    }
                }
                _ => {}
            }
        }
        self.save();
    }

    pub fn add_service(&self, service: Service) {
        {
            let mut data = self.data.write();
            data.services.push(service);
        }
        self.save();
    }

    pub fn update_service(&self, id: &str, service: Service) {
        {
            let mut data = self.data.write();
            if let Some(slot) = data.services.iter_mut().find(|s| s.id == id) {
                *slot = service;
            }
        }
        self.save();
    }

    pub fn remove_service(&self, id: &str) {
        {
            let mut data = self.data.write();
            data.services.retain(|s| s.id != id);
        }
        self.save();
    }

    /// Grava em arquivo temporario e renomeia: evita config corrompido se o
    /// app for fechado no meio de um save.
    pub fn save(&self) {
        let data = self.data.read();
        let json = match serde_json::to_string_pretty(&*data) {
            Ok(text) => text,
            Err(err) => {
                eprintln!("[store] falha ao serializar: {err}");
                return;
            }
        };
        drop(data);

        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }

        let tmp = self.path.with_extension(format!("tmp{}", std::process::id()));
        if let Err(err) = fs::write(&tmp, format!("{json}\n")) {
            eprintln!("[store] falha ao gravar: {err}");
            return;
        }
        if let Err(err) = fs::rename(&tmp, &self.path) {
            eprintln!("[store] falha ao renomear: {err}");
            let _ = fs::remove_file(&tmp);
        }
    }
}

fn read_config(path: &Path) -> Config {
    let Ok(text) = fs::read_to_string(path) else {
        return Config::default();
    };
    if text.trim().is_empty() {
        return Config::default();
    }

    match serde_json::from_str::<Config>(&text) {
        Ok(mut config) => {
            for service in &mut config.services {
                normalize_service(service);
            }
            config
        }
        Err(err) => {
            // Config invalido: preserva o original para inspecao e comeca limpo.
            let backup = path.with_extension(format!("corrompido-{}", chrono::Utc::now().timestamp()));
            let _ = fs::copy(path, backup);
            eprintln!("[store] config invalido ({err}), backup criado");
            Config::default()
        }
    }
}

/// Completa campos ausentes e saneia valores, igual ao normalizador do
/// painel em JavaScript.
pub fn normalize_service(service: &mut Service) {
    if service.id.is_empty() {
        service.id = uuid_v4();
    }
    if service.name.trim().is_empty() {
        service.name = "Servidor".into();
    }
    if service.group.trim().is_empty() {
        service.group = "Geral".into();
    }
    if service.created_at.is_empty() {
        service.created_at = chrono::Utc::now().to_rfc3339();
    }

    service.health.port = service.health.port.filter(|p| *p > 0);
    service.health.interval_ms = service.health.interval_ms.max(1000);
    service.health.timeout_ms = service.health.timeout_ms.max(500);
    service.health.failures_before_unhealthy = service.health.failures_before_unhealthy.max(1);

    service.restart.max_backoff_ms = service.restart.max_backoff_ms.max(service.restart.backoff_ms);
    service.restart.stability_ms = service.restart.stability_ms.max(5000);

    if service.kind == ServiceKind::Docker && service.container.trim().is_empty() {
        eprintln!("[store] servico docker sem container: {}", service.name);
    }
    if service.kind == ServiceKind::Servico && service.service.trim().is_empty() {
        eprintln!("[store] servico windows sem nome: {}", service.name);
    }
}

/// Identificador unico (versao sem dependencias do crate uuid).
pub fn uuid_v4() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;

    let mut state = nanos ^ (pid << 64) ^ 0x9E37_79B9_7F4A_7C15;
    let mut bytes = [0u8; 16];
    for byte in bytes.iter_mut() {
        // xorshift: simples o bastante para um id local.
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        *byte = (state & 0xFF) as u8;
    }
    bytes[6] = (bytes[6] & 0x0F) | 0x40;
    bytes[8] = (bytes[8] & 0x3F) | 0x80;

    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Converte o payload JSON da interface em um servico normalizado.
pub fn service_from_json(value: serde_json::Value) -> Service {
    // Os campos que a interface envia com nomes proprios sao lidos antes de
    // consumir o valor.
    let kind = value
        .get("type")
        .and_then(|v| v.as_str())
        .map(|kind| match kind {
            "docker" => ServiceKind::Docker,
            "servico" => ServiceKind::Servico,
            _ => ServiceKind::Processo,
        });

    let health_kind = value
        .get("health")
        .and_then(|health| health.get("type"))
        .and_then(|v| v.as_str())
        .map(|kind| match kind {
            "tcp" => HealthKind::Tcp,
            "http" => HealthKind::Http,
            _ => HealthKind::None,
        });

    let env = value.get("env").and_then(|v| v.as_object()).map(|env| {
        env.iter()
            .filter_map(|(k, v)| v.as_str().map(|val| (k.clone(), val.to_string())))
            .collect::<BTreeMap<String, String>>()
    });

    let args = value.get("args").and_then(|v| v.as_array()).map(|args| {
        args.iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect::<Vec<String>>()
    });

    let mut service: Service = serde_json::from_value(value).unwrap_or_default();

    if let Some(kind) = kind {
        service.kind = kind;
    }
    if let Some(kind) = health_kind {
        service.health.kind = kind;
    }
    if let Some(env) = env {
        service.env = env;
    }
    if let Some(args) = args {
        service.args = args;
    }

    normalize_service(&mut service);
    service
}

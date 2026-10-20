//! Cliente do Docker.
//
//! Fala com a CLI (`docker ...`) em vez da API do Engine pelo named pipe.
//!
//! A API pelo pipe seria mais leve (sem subir um docker.exe por operacao),
//! mas o pipe aceita apenas um cliente por vez em modo byte: com varios
//! containers sendo acompanhados, as consultas comecam a falhar com
//! ERROR_PIPE_BUSY (231). A CLI usa I/O overlapped e convive com as
//! consultas, como ja funcionava na versao em Electron.

use std::process::Command;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::types::{Container, PortInfo};

/// Caminho do executavel do docker (o Docker Desktop o coloca no PATH).
fn binary() -> &'static str {
    static BIN: OnceLock<&'static str> = OnceLock::new();
    *BIN.get_or_init(|| "docker")
}

#[cfg(windows)]
fn criar_comando(programa: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let mut command = Command::new(programa);
    // CREATE_NO_WINDOW: sem janela de console ao lado.
    command.creation_flags(0x08000000);
    command
}

#[cfg(not(windows))]
fn criar_comando(programa: &str) -> Command {
    Command::new(programa)
}

/// Executa a CLI e devolve a saida.
fn executar(args: &[&str]) -> Result<String, String> {
    let output = criar_comando(binary())
        .args(args)
        .output()
        .map_err(|err| format!("nao foi possivel executar o docker: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("o docker falhou (codigo {:?})", output.status.code())
        } else {
            stderr
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// A CLI esta disponivel e o daemon responde?
pub async fn availability() -> (bool, String) {
    match executar(&["version", "--format", "{{.Server.Version}}"]) {
        Ok(version) => (true, version.trim().to_string()),
        Err(_) => (false, "Docker nao encontrado ou daemon parado".to_string()),
    }
}

#[derive(Debug, Clone, Deserialize)]
struct LinhaContainer {
    #[serde(rename = "ID")]
    id: String,
    #[serde(rename = "Names")]
    names: String,
    #[serde(rename = "Image")]
    image: String,
    #[serde(rename = "State")]
    state: String,
    #[serde(rename = "Status")]
    status: String,
    #[serde(rename = "Ports")]
    ports: String,
}

/// Lista os containers (rodando e parados).
pub async fn list_containers() -> Result<Vec<Container>, String> {
    let saida = executar(&["ps", "-a", "--format", "{{json .}}"])?;

    let containers = saida
        .lines()
        .filter(|linha| !linha.trim().is_empty())
        .filter_map(|linha| serde_json::from_str::<LinhaContainer>(linha).ok())
        .map(|linha| Container {
            id: linha.id,
            name: linha.names,
            image: linha.image,
            state: linha.state.to_lowercase(),
            status: linha.status,
            ports: linha.ports,
            created_at: String::new(),
        })
        .collect();

    Ok(containers)
}

#[derive(Debug, Clone, Serialize)]
pub struct InspectInfo {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub running: bool,
    pub exit_code: i32,
    pub started_at: String,
    pub health: Option<String>,
    pub health_log: Option<String>,
    pub ports: Vec<PortInfo>,
}

#[derive(Debug, Clone, Deserialize)]
struct Estado {
    #[serde(rename = "Status")]
    status: String,
    #[serde(rename = "Running")]
    running: bool,
    #[serde(rename = "ExitCode")]
    exit_code: i32,
    #[serde(rename = "StartedAt")]
    started_at: String,
    #[serde(rename = "Health")]
    health: Option<Saude>,
}

#[derive(Debug, Clone, Deserialize)]
struct Saude {
    #[serde(rename = "Status")]
    status: String,
    #[serde(rename = "Log")]
    log: Option<Vec<RegistroSaude>>,
}

#[derive(Debug, Clone, Deserialize)]
struct RegistroSaude {
    #[serde(rename = "Output")]
    output: String,
}

#[derive(Debug, Clone, Deserialize)]
struct Config {
    #[serde(rename = "Image")]
    image: String,
}

#[derive(Debug, Clone, Deserialize)]
struct Redes {
    #[serde(rename = "Ports")]
    ports: std::collections::HashMap<String, Option<Vec<Vinculo>>>,
}

#[derive(Debug, Clone, Deserialize)]
struct Vinculo {
    #[serde(rename = "HostPort")]
    host_port: String,
    #[serde(rename = "HostIp")]
    host_ip: String,
}

#[derive(Debug, Clone, Deserialize)]
struct Info {
    #[serde(rename = "Id")]
    id: String,
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "State")]
    state: Estado,
    #[serde(rename = "Config")]
    config: Config,
    #[serde(rename = "NetworkSettings")]
    network: Redes,
}

/// Detalha um container.
pub async fn inspect(container: &str) -> Result<InspectInfo, String> {
    let saida = executar(&["inspect", container, "--format", "{{json .}}"])?;

    // Com --format a saida e um objeto; sem ele, um array.
    let valor: serde_json::Value = serde_json::from_str(&saida).map_err(|err| err.to_string())?;
    let objeto = match valor {
        serde_json::Value::Array(mut itens) if !itens.is_empty() => itens.remove(0),
        outro => outro,
    };
    let info: Info = serde_json::from_value(objeto).map_err(|err| err.to_string())?;

    let mut ports = Vec::new();
    for (porta, vinculos) in &info.network.ports {
        match vinculos {
            None => ports.push(PortInfo {
                port: porta.clone(),
                published: None,
                host: None,
            }),
            Some(lista) => {
                for vinculo in lista {
                    ports.push(PortInfo {
                        port: porta.clone(),
                        published: Some(vinculo.host_port.clone()),
                        host: Some(vinculo.host_ip.clone()),
                    });
                }
            }
        }
    }

    let health_log = info
        .state
        .health
        .as_ref()
        .and_then(|saude| saude.log.as_ref())
        .and_then(|registros| registros.last())
        .map(|registro| registro.output.trim().to_string())
        .filter(|texto| !texto.is_empty());

    Ok(InspectInfo {
        id: info.id.chars().take(12).collect(),
        name: info.name.trim_start_matches('/').to_string(),
        image: info.config.image,
        state: info.state.status.to_lowercase(),
        running: info.state.running,
        exit_code: info.state.exit_code,
        started_at: info.state.started_at,
        health: info
            .state
            .health
            .as_ref()
            .map(|saude| saude.status.to_lowercase()),
        health_log,
        ports,
    })
}

/// Liga um container.
pub async fn start(container: &str) -> Result<(), String> {
    executar(&["start", container]).map(|_| ())
}

/// Desliga um container.
pub async fn stop(container: &str, timeout_secs: u64) -> Result<(), String> {
    executar(&["stop", "-t", &timeout_secs.to_string(), container]).map(|_| ())
}

/// Reinicia um container.
pub async fn restart(container: &str, timeout_secs: u64) -> Result<(), String> {
    executar(&["restart", "-t", &timeout_secs.to_string(), container]).map(|_| ())
}

/// Estatisticas de recurso do container.
pub async fn stats(container: &str) -> Result<StatsInfo, String> {
    let saida = executar(&[
        "stats",
        "--no-stream",
        "--format",
        "{{json .}}",
        container,
    ])?;

    let linha = saida
        .lines()
        .find(|linha| !linha.trim().is_empty())
        .ok_or("sem dados de recursos do container")?;
    let valor: serde_json::Value = serde_json::from_str(linha).map_err(|err| err.to_string())?;

    let cpu = valor
        .get("CPUPerc")
        .and_then(|v| v.as_str())
        .and_then(|texto| texto.trim_end_matches('%').parse::<f64>().ok())
        .unwrap_or(0.0);

    let memoria = valor
        .get("MemUsage")
        .and_then(|v| v.as_str())
        .map(|texto| converter_tamanho(texto.split('/').next().unwrap_or("").trim()))
        .unwrap_or(0.0);


    let percentual = valor
        .get("MemPerc")
        .and_then(|v| v.as_str())
        .and_then(|texto| texto.trim_end_matches('%').parse::<f64>().ok())
        .unwrap_or(0.0);


    Ok(StatsInfo {
        cpu: (cpu * 10.0).round() / 10.0,
        mem: (memoria * 10.0).round() / 10.0,
        mem_percent: (percentual * 10.0).round() / 10.0,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct StatsInfo {
    pub cpu: f64,
    pub mem: f64,
    pub mem_percent: f64,
}

/// Converte "45.2MiB" em megabytes.
fn converter_tamanho(valor: &str) -> f64 {
    let partes: Vec<&str> = valor.split_whitespace().collect();
    if partes.len() != 2 {
        return 0.0;
    }
    let numero: f64 = partes[0].parse().unwrap_or(0.0);
    let fator = match partes[1].to_ascii_lowercase().as_str() {
        "b" => 1.0 / (1024.0 * 1024.0),
        "kb" | "kib" => 1.0 / 1024.0,
        "mb" | "mib" => 1.0,
        "gb" | "gib" => 1024.0,
        "tb" | "tib" => 1024.0 * 1024.0,
        _ => return 0.0,
    };
    numero * fator
}

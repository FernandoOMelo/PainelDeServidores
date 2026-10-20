//! Servicos do Windows (Service Control Manager).
//!
//! A leitura usa o sc.exe, que devolve o estado como numero - o mesmo em
//! qualquer idioma do Windows. O modo de inicializacao e o caminho do
//! executavel vem do registro, tambem independente de idioma.

use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde::Serialize;

use crate::types::WindowsService;

/// Estado numerico do sc.exe.
pub fn state_name(number: u32) -> &'static str {
    match number {
        1 => "Stopped",
        2 => "Start Pending",
        3 => "Stop Pending",
        4 => "Running",
        5 => "Continue Pending",
        6 => "Pause Pending",
        7 => "Paused",
        _ => "Unknown",
    }
}

/// Modo de inicializacao (registro) -> rotulo.
pub fn start_mode_name(value: u32) -> &'static str {
    match value {
        0 => "Boot",
        1 => "System",
        2 => "Auto",
        3 => "Manual",
        4 => "Disabled",
        _ => "Unknown",
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ServiceStatus {
    pub name: String,
    pub display_name: String,
    pub state: String,
    pub state_number: u32,
    pub start_mode: String,
    pub pid: Option<u32>,
    pub path: String,
}

/// Executa o sc.exe e devolve (codigo de saida, saida).
fn sc(args: &[&str]) -> (i32, String) {
    let output = Command::new("sc.exe")
        .args(args)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output();

    match output {
        Ok(out) => (out.status.code().unwrap_or(0), String::from_utf8_lossy(&out.stdout).to_string()),
        Err(_) => (-1, String::new()),
    }
}

/// Estado e PID de um servico.
pub fn query(name: &str) -> Option<ServiceStatus> {
    let (code, out) = sc(&["queryex", name]);
    if code != 0 {
        return None;
    }

    let lines: Vec<&str> = out.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if lines.len() < 4 {
        return None;
    }

    let service_name = lines[0].split_once(": ").map(|(_, v)| v.trim()).unwrap_or(name);
    let display_name = lines[1].split_once(": ").map(|(_, v)| v.trim()).unwrap_or(service_name);

    // A linha de estado e a quarta do bloco: "ESTADO : 4  RUNNING".
    let state_number = lines[3]
        .split_once(": ")
        .and_then(|(_, v)| v.split_whitespace().next())
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0);

    // O PID aparece em uma linha rotulada "PID" (igual em qualquer idioma).
    let pid = lines
        .iter()
        .find(|line| {
            line.split_once(": ")
                .map(|(label, _)| label.eq_ignore_ascii_case("PID"))
                .unwrap_or(false)
        })
        .and_then(|line| line.split_once(": "))
        .and_then(|(_, v)| v.split_whitespace().next())
        .and_then(|v| v.parse::<u32>().ok());

    let (start_mode, path) = config(service_name);

    Some(ServiceStatus {
        name: service_name.to_string(),
        display_name: display_name.to_string(),
        state: state_name(state_number).to_string(),
        state_number,
        start_mode,
        pid,
        path,
    })
}

/// Todos os servicos registrados, em uma unica chamada ao sc.exe.
pub fn list() -> Vec<WindowsService> {
    let (code, out) = sc(&["query", "type=", "service", "state=", "all"]);
    if code != 0 {
        return Vec::new();
    }

    let mut services = Vec::new();
    let mut block: Vec<String> = Vec::new();

    let flush = |block: &mut Vec<String>, services: &mut Vec<WindowsService>| {
        if block.len() < 4 {
            block.clear();
            return;
        }
        let name = block[0].split_once(": ").map(|(_, v)| v.trim().to_string());
        let display = block[1].split_once(": ").map(|(_, v)| v.trim().to_string());
        let state_number = block[3]
            .split_once(": ")
            .and_then(|(_, v)| v.split_whitespace().next())
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0);

        if let Some(name) = name {
            let pid = block
                .iter()
                .find(|line| {
                    line.split_once(": ")
                        .map(|(label, _)| label.eq_ignore_ascii_case("PID"))
                        .unwrap_or(false)
                })
                .and_then(|line| line.split_once(": "))
                .and_then(|(_, v)| v.split_whitespace().next())
                .and_then(|v| v.parse::<u32>().ok());

            services.push(WindowsService {
                name: name.clone(),
                display_name: display.unwrap_or_else(|| name.clone()),
                state: state_name(state_number).to_string(),
                start_mode: String::new(),
                pid,
                path: String::new(),
            });
        }
        block.clear();
    };

    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() {
            flush(&mut block, &mut services);
            continue;
        }
        block.push(line.to_string());
    }
    flush(&mut block, &mut services);

    // Modo de inicializacao e caminho vem do registro (so para os que importam).
    for service in services.iter_mut() {
        let (mode, path) = config(&service.name);
        service.start_mode = mode;
        service.path = path;
    }

    services
}

/// Modo de inicializacao e caminho do executavel, lidos do registro.
pub fn config(name: &str) -> (String, String) {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let Ok(hkey) = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(
                "SYSTEM\\CurrentControlSet\\Services",
                KEY_READ,
            )
        else {
            return (String::new(), String::new());
        };
        let Ok(service) = hkey.open_subkey(name) else {
            return (String::new(), String::new());
        };

        let start = service.get_value::<u32, _>("Start").unwrap_or(3);
        let image: String = service.get_value::<String, _>("ImagePath").unwrap_or_default();

        (start_mode_name(start).to_string(), image)
    }
    #[cfg(not(windows))]
    {
        let _ = name;
        (String::new(), String::new())
    }
}

/// Resultado de um start/stop: codigo e mensagem traduzida.
pub struct ControlResult {
    pub ok: bool,
    pub code: i32,
    pub message: String,
    pub needs_elevation: bool,
}

fn control(args: &[&str]) -> ControlResult {
    let (code, out) = sc(args);

    if code == 0 {
        return ControlResult {
            ok: true,
            code,
            message: String::new(),
            needs_elevation: false,
        };
    }

    let needs_elevation = code == 5;
    ControlResult {
        ok: false,
        code,
        message: translate_error(code, &out),
        needs_elevation,
    }
}

pub fn start(name: &str) -> ControlResult {
    control(&["start", name])
}

pub fn stop(name: &str) -> ControlResult {
    control(&["stop", name])
}

pub fn restart(name: &str) -> ControlResult {
    control(&["restart", name])
}

/// Traduz os codigos do sc.exe em mensagens uteis.
pub fn translate_error(code: i32, output: &str) -> String {
    match code {
        5 => "Acesso negado ao abrir o servico. Reinicie o painel como administrador para poder iniciar ou parar servicos do Windows.".to_string(),
        1053 => "O servico nao respondeu a tempo para iniciar ou parar.".to_string(),
        1056 => "O servico ja esta em execucao.".to_string(),
        1057 => "O servico nao foi iniciado.".to_string(),
        1058 => "O servico esta desabilitado.".to_string(),
        1060 => "O servico nao existe.".to_string(),
        1061 => "O servico foi marcado para exclusao.".to_string(),
        1062 => "O servico nao esta em execucao.".to_string(),
        _ => {
            let trimmed = output.trim();
            if trimmed.is_empty() {
                format!("Falha (codigo {code}) ao controlar o servico.")
            } else {
                trimmed.to_string()
            }
        }
    }
}

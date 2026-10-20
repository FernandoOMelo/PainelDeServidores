//! Varredura das portas em escuta da maquina e identificacao de quem responde.

use std::collections::HashMap;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::types::{ListeningPort, PortOwner};

/// Cache de nome por PID: evita refazer a consulta a cada varredura.
static NAME_CACHE: Mutex<Option<HashMap<u32, (String, Instant)>>> = Mutex::new(None);
const NAME_CACHE_TTL: Duration = Duration::from_secs(120);

/// Cache da varredura completa.
static PORT_CACHE: Mutex<Option<(Instant, Vec<ListeningPort>)>> = Mutex::new(None);
const PORT_CACHE_TTL: Duration = Duration::from_secs(5);

fn run(program: &str, args: &[&str]) -> String {
    Command::new(program)
        .args(args)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).to_string())
        .unwrap_or_default()
}

/// Portas escutando agora.
pub fn listening_ports() -> Vec<ListeningPort> {
    {
        let cache = PORT_CACHE.lock().unwrap();
        if let Some((at, rows)) = cache.as_ref() {
            if at.elapsed() < PORT_CACHE_TTL {
                return rows.clone();
            }
        }
    }

    let output = run("netstat.exe", &["-ano", "-p", "TCP"]);
    let mut entries: Vec<ListeningPort> = Vec::new();
    let mut seen: HashMap<u16, u32> = HashMap::new();

    for line in output.lines() {
        let trimmed = line.trim();
        if !trimmed.to_ascii_uppercase().starts_with("TCP") {
            continue;
        }
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() < 5 {
            continue;
        }
        // A coluna de estado vem antes do PID; em pt-BR e "LISTENING".
        if !parts[parts.len() - 2].eq_ignore_ascii_case("LISTENING") {
            continue;
        }

        let local = parts[1];
        let Some(colon) = local.rfind(':') else { continue };
        let Ok(port) = local[colon + 1..].parse::<u16>() else { continue };
        let Ok(pid) = parts[parts.len() - 1].parse::<u32>() else { continue };

        // A mesma porta aparece em IPv4 e IPv6: fica uma entrada so.
        if let Some(existing) = seen.get(&port) {
            if *existing != pid {
                continue;
            }
        }
        seen.insert(port, pid);

        let host = local[..colon].trim_matches(['[', ']']).to_string();
        entries.push(ListeningPort {
            pid,
            port,
            host,
            address: local.to_string(),
            process: String::new(),
        });
    }

    // Quem responde em cada porta.
    let pids: Vec<u32> = entries.iter().map(|e| e.pid).collect();
    let names = process_names(&pids);
    for entry in entries.iter_mut() {
        entry.process = names.get(&entry.pid).cloned().unwrap_or_else(|| "desconhecido".into());
    }

    *PORT_CACHE.lock().unwrap() = Some((Instant::now(), entries.clone()));
    entries
}

/// Nome dos processos por PID, com cache de dois minutos.
fn process_names(pids: &[u32]) -> HashMap<u32, String> {
    let mut out: HashMap<u32, String> = HashMap::new();
    let mut missing: Vec<u32> = Vec::new();
    let now = Instant::now();

    {
        let cache = NAME_CACHE.lock().unwrap();
        if let Some(map) = cache.as_ref() {
            for &pid in pids {
                match map.get(&pid) {
                    Some((name, at)) if now.duration_since(*at) < NAME_CACHE_TTL => {
                        out.insert(pid, name.clone());
                    }
                    _ => missing.push(pid),
                }
            }
        } else {
            missing.extend_from_slice(pids);
        }
    }

    if !missing.is_empty() {
        // tasklist responde em ~1,4s e pesa ~10 MB; a alternativa (PowerShell)
        // custa ~60 MB por consulta.
        let output = run("tasklist.exe", &["/FO", "CSV", "/NH"]);
        let wanted: std::collections::HashSet<u32> = missing.iter().copied().collect();
        let mut fresh: HashMap<u32, String> = HashMap::new();

        for line in output.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let mut fields = line.split('"');
            fields.next(); // abre aspas
            let name = fields.next().unwrap_or("").to_string();
            let pid_field = fields.next().unwrap_or("").trim();
            let Ok(pid) = pid_field.parse::<u32>() else { continue };
            if wanted.contains(&pid) && !name.is_empty() {
                fresh.insert(pid, name);
            }
        }

        let mut cache = NAME_CACHE.lock().unwrap();
        let map = cache.get_or_insert_with(HashMap::new);
        for (pid, name) in fresh {
            map.insert(pid, (name.clone(), now));
            out.insert(pid, name);
        }
    }

    out
}

/// Quem esta escutando uma porta especifica.
pub fn find_port_owner(port: u16) -> Option<PortOwner> {
    let rows = listening_ports();
    let row = rows.iter().find(|r| r.port == port)?;
    Some(PortOwner {
        process: row.process.clone(),
        pid: row.pid,
        address: row.address.clone(),
    })
}

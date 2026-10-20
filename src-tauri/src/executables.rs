//! Execucao de processos: node proprio por servico e deteccao de versao.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::Mutex;

use serde::Serialize;

/// Cache das versoes detectadas (por caminho).
static VERSION_CACHE: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

/// Como o comando sera executado, ja com o node customizado resolvido.
#[derive(Debug, Clone)]
pub struct Execution {
    pub command: String,
    pub args: Vec<String>,
    /// Variaveis de ambiente extras (PATH com a pasta do node).
    pub env: HashMap<String, String>,
    pub node_path: Option<PathBuf>,
    pub warning: Option<String>,
}

/// Pastas onde costuma ficar um node embarcado no projeto.
const EMBEDDED_DIRS: &[&str] = &[
    "node",
    "nodejs",
    ".node",
    "node-runtime",
    "nodejs/bin",
    "node/bin",
    "vendor/node",
    "vendor/nodejs",
    "runtime/node",
    "runtime/nodejs",
    "runtime/.node",
    "bin",
];

/// Procura o node.exe a partir de um caminho (arquivo ou pasta).
pub fn resolve_node_executable(configured: &str, app_root: &Path) -> Option<PathBuf> {
    let raw = configured.trim();
    if raw.is_empty() {
        return None;
    }

    let target = if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        app_root.join(raw)
    };

    if target.is_dir() {
        let inside = target.join("node.exe");
        return inside.is_file().then_some(inside);
    }
    target.is_file().then_some(target)
}

/// Monta comando, argumentos e ambiente de execucao.
///
/// Quando o servico define um node proprio, a pasta dele entra no PATH
/// (para que npm, npx e os filhos usem a mesma versao) e os comandos
/// node/npm/npx passam a ser resolvidos por caminho absoluto.
pub fn resolve_execution(
    command: &str,
    args: &[String],
    node_path: &str,
    app_root: &Path,
) -> Execution {
    let mut execution = Execution {
        command: command.to_string(),
        args: args.to_vec(),
        env: HashMap::new(),
        node_path: None,
        warning: None,
    };

    let configured = node_path.trim();
    if configured.is_empty() {
        return execution;
    }

    let Some(node_exe) = resolve_node_executable(configured, app_root) else {
        execution.warning = Some(format!("Node customizado nao encontrado: {configured}"));
        return execution;
    };

    let dir = node_exe
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| app_root.to_path_buf());
    execution.node_path = Some(node_exe);

    let current = std::env::var("PATH").unwrap_or_default();
    execution.env.insert(
        "PATH".to_string(),
        if current.is_empty() {
            dir.to_string_lossy().to_string()
        } else {
            format!("{};{}", dir.to_string_lossy(), current)
        },
    );

    // node / npm / npx passam a ser o do node escolhido.
    let base = command
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(command)
        .to_ascii_lowercase();
    let target = match base.as_str() {
        "node" | "node.exe" => Some("node.exe"),
        "npm" | "npm.cmd" => Some("npm.cmd"),
        "npx" | "npx.cmd" => Some("npx.cmd"),
        _ => None,
    };

    if let Some(file) = target {
        let candidate = dir.join(file);
        if candidate.is_file() {
            execution.command = candidate.to_string_lossy().to_string();
        } else {
            execution.warning = Some(format!(
                "\"{base}\" nao encontrado em {}; usando o PATH do sistema.",
                dir.to_string_lossy()
            ));
        }
    }

    execution
}

/// Versao do node em um caminho especifico ("v18.20.8").
pub fn detect_node_version(node_path: &Path) -> Option<String> {
    let key = node_path.to_string_lossy().to_string();

    {
        let cache = VERSION_CACHE.lock().unwrap();
        if let Some(map) = cache.as_ref() {
            if let Some(value) = map.get(&key) {
                return value.clone();
            }
        }
    }

    let output = Command::new(node_path)
        .arg("--version")
        .creation_flags(0x08000000)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let version = if version.is_empty() { None } else { Some(version) };

    let mut cache = VERSION_CACHE.lock().unwrap();
    cache
        .get_or_insert_with(HashMap::new)
        .insert(key, version.clone());

    version
}

/// Node embarcado dentro da pasta de um projeto.
#[derive(Debug, Clone, Serialize)]
pub struct EmbeddedNode {
    pub path: String,
    pub version: Option<String>,
    pub npm: bool,
}

/// Procura node.exe dentro de uma pasta de projeto.
pub fn find_embedded_nodes(dir: &Path) -> Vec<EmbeddedNode> {
    let mut found: Vec<PathBuf> = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    let mut consider = |candidate: PathBuf, found: &mut Vec<PathBuf>, seen: &mut Vec<String>| {
        let key = candidate.to_string_lossy().to_ascii_lowercase();
        if seen.contains(&key) {
            return;
        }
        if candidate.is_file() {
            seen.push(key);
            found.push(candidate);
        }
    };

    consider(dir.join("node.exe"), &mut found, &mut seen);
    for relative in EMBEDDED_DIRS {
        consider(dir.join(relative).join("node.exe"), &mut found, &mut seen);
    }

    // Varredura rasa das subpastas imediatas.
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            consider(path.join("node.exe"), &mut found, &mut seen);
            consider(path.join("node").join("node.exe"), &mut found, &mut seen);
            consider(path.join("nodejs").join("node.exe"), &mut found, &mut seen);
            consider(path.join("bin").join("node.exe"), &mut found, &mut seen);
            consider(path.join("runtime").join("node").join("node.exe"), &mut found, &mut seen);
        }
    }

    found
        .into_iter()
        .map(|exe| {
            let version = detect_node_version(&exe);
            let npm = exe
                .parent()
                .map(|dir| dir.join("npm.cmd").is_file())
                .unwrap_or(false);
            EmbeddedNode {
                path: exe.to_string_lossy().to_string(),
                version,
                npm,
            }
        })
        .collect()
}

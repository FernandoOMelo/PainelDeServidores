//! Inicializacao automatica com o Windows.
//!
//! Nao da para confiar so na leitura do Electron: no modo dev ele grava uma
//! chave e consulta outra, e o status voltaria sempre desligado. Por isso a
//! leitura e feita direto no registro, casando pelo caminho do executavel.

use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// Executavel atual (o proprio app, ou o host que o hospeda).
pub fn current_exe() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Argumentos do atalho: em desenvolvimento o caminho do projeto vai junto.
pub fn login_args() -> String {
    if cfg!(debug_assertions) {
        let project = std::env::current_exe()
            .ok()
            .and_then(|exe| {
                exe.parent()
                    .and_then(|p| p.parent())
                    .and_then(|p| p.parent())
                    .map(|p| p.to_string_lossy().to_string())
            })
            .unwrap_or_default();
        format!("\"{project}\" --hidden")
    } else {
        "--hidden".to_string()
    }
}

/// Valor gravado no registro.
fn registry_value() -> String {
    let exe = current_exe();
    format!("\"{exe}\" {}", login_args())
}

/// O app esta configurado para subir com o Windows?
pub fn is_enabled() -> bool {
    own_entries().iter().any(|value| value.contains(&current_exe()))
}

/// Entradas do registro que apontam para este executavel.
fn own_entries() -> Vec<String> {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::types::FromRegValue;
        use winreg::RegKey;

        let Ok(hkey) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(RUN_KEY) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for (_, value) in hkey.enum_values().flatten() {
            if let Ok(text) = String::from_reg_value(&value) {
                out.push(text);
            }
        }
        out
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// Liga ou desliga a inicializacao automatica.
pub fn set_enabled(enabled: bool) -> bool {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        if enabled {
            let Ok((hkey, _)) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(RUN_KEY) else {
                return false;
            };
            let value = registry_value();
            let _ = hkey.set_value("PainelDeServidores", &value);
        } else {
            remove_own_entries();
        }
    }

    is_enabled()
}

/// Remove as entradas do registro que apontam para este executavel.
pub fn remove_own_entries() {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::types::FromRegValue;
        use winreg::RegKey;

        let Ok(hkey) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(RUN_KEY, KEY_READ) else {
            return;
        };
        let exe = current_exe();
        for (name, value) in hkey.enum_values().flatten() {
            if let Ok(text) = String::from_reg_value(&value) {
                if text.contains(&exe) {
                    let _ = hkey.delete_value(&name);
                }
            }
        }
    }
}

/// Reabre o app com permissao de administrador.
pub fn relaunch_elevated() -> bool {
    let exe = current_exe();
    let args = login_args();

    let script = format!(
        "Start-Process -FilePath '{exe}' -ArgumentList {args} -Verb RunAs"
    );

    Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .creation_flags(0x08000000)
        .spawn()
        .is_ok()
}

/// O processo roda com token elevado?
pub fn is_elevated() -> bool {
    #[cfg(windows)]
    {
        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
            ])
            .creation_flags(0x08000000)
            .output();

        match output {
            Ok(out) => String::from_utf8_lossy(&out.stdout)
                .trim()
                .eq_ignore_ascii_case("true"),
            Err(_) => false,
        }
    }
    #[cfg(not(windows))]
    {
        false
    }
}

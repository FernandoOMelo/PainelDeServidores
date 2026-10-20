//! Coleta de CPU e memoria por processo usando a API nativa do Windows.
//!
//! A versao anterior usava um PowerShell persistente, que custava ~80 MB de
//! memoria. Com GetProcessTimes e GetProcessMemoryInfo nao ha processo
//! nenhum: a leitura e feita direto do kernel.

use std::collections::HashMap;
use std::time::Instant;

#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
#[cfg(windows)]
use windows::Win32::System::ProcessStatus::{
    GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
};
#[cfg(windows)]
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// Uma amostra de recurso de um processo.
#[derive(Debug, Clone, Copy)]
pub struct ProcessSample {
    pub pid: u32,
    /// Porcentagem de CPU (100% = um nucleo cheio).
    pub cpu_percent: f64,
    /// Memoria resident, em megabytes.
    pub mem_mb: f64,
}

/// Guarda o estado anterior para calcular a variacao de CPU.
#[derive(Debug, Clone, Copy)]
struct Previous {
    cpu_seconds: f64,
    at: Instant,
}

pub struct MetricsCollector {
    previous: HashMap<u32, Previous>,
}

impl Default for MetricsCollector {
    fn default() -> Self {
        Self::new()
    }
}

impl MetricsCollector {
    pub fn new() -> Self {
        Self {
            previous: HashMap::new(),
        }
    }

    /// Amostra um conjunto de processos.
    pub fn sample(&mut self, pids: &[u32]) -> Vec<ProcessSample> {
        let now = Instant::now();
        let mut out = Vec::with_capacity(pids.len());

        for &pid in pids {
            let Some((cpu_seconds, mem_bytes)) = read_process(pid) else {
                continue;
            };

            let cpu_percent = match self.previous.get(&pid) {
                Some(previous) => {
                    let elapsed = now.duration_since(previous.at).as_secs_f64();
                    if elapsed > 0.0 {
                        ((cpu_seconds - previous.cpu_seconds) / elapsed * 100.0).max(0.0)
                    } else {
                        0.0
                    }
                }
                None => 0.0,
            };

            self.previous.insert(
                pid,
                Previous {
                    cpu_seconds,
                    at: now,
                },
            );

            out.push(ProcessSample {
                pid,
                cpu_percent: (cpu_percent * 10.0).round() / 10.0,
                mem_mb: (mem_bytes as f64 / (1024.0 * 1024.0) * 10.0).round() / 10.0,
            });
        }

        // Descarta PIDs que sairam de cena.
        self.previous.retain(|pid, _| pids.contains(pid));

        out
    }
}

/// Le o tempo de CPU (segundos) e a memoria resident de um processo.
#[cfg(windows)]
fn read_process(pid: u32) -> Option<(f64, u64)> {
    unsafe {
        let handle: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;

        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();

        let ok = GetProcessTimes(
            handle,
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
        .is_ok();
        if !ok {
            let _ = CloseHandle(handle);
            return None;
        }

        let mut counters = PROCESS_MEMORY_COUNTERS::default();
        let mem_ok = GetProcessMemoryInfo(
            handle,
            &mut counters,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        )
        .is_ok();

        let _ = CloseHandle(handle);

        if !mem_ok {
            return None;
        }

        // FILETIME esta em 100 nanossegundos.
        let ticks = (kernel.dwHighDateTime as u64) << 32 | kernel.dwLowDateTime as u64;
        let user_ticks = (user.dwHighDateTime as u64) << 32 | user.dwLowDateTime as u64;
        let cpu_seconds = (ticks + user_ticks) as f64 / 10_000_000.0;

        Some((cpu_seconds, counters.WorkingSetSize as u64))
    }
}

#[cfg(not(windows))]
fn read_process(_pid: u32) -> Option<(f64, u64)> {
    None
}

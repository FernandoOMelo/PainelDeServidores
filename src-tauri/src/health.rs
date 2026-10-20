//! Verificacao de saude: porta TCP e endpoint HTTP.

use std::time::{Duration, Instant};

use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::discovery;
use crate::types::{HealthConfig, HealthDetail, HealthKind, HealthResult, HealthState};

/// Verifica se o servico esta de pe.
pub async fn check(config: &HealthConfig) -> HealthResult {
    if config.kind == HealthKind::None {
        return HealthResult {
            ok: true,
            state: HealthState::Unknown,
            latency_ms: 0,
            error: None,
            status: None,
            owner: None,
        };
    }

    let Some(port) = config.port else {
        return HealthResult {
            ok: false,
            state: HealthState::Unknown,
            latency_ms: 0,
            error: Some("Nenhuma porta configurada".into()),
            status: None,
            owner: None,
        };
    };

    let started = Instant::now();
    let (ok, error, status) = match config.kind {
        HealthKind::Tcp => check_tcp(port, config.timeout_ms).await,
        HealthKind::Http => check_http(port, config, config.timeout_ms).await,
        HealthKind::None => unreachable!(),
    };

    let latency_ms = started.elapsed().as_millis() as u64;

    // Quem responde nessa porta: evita o falso positivo de outro servico
    // estar ocupando a mesma porta.
    let owner = if ok {
        tokio::task::spawn_blocking(move || discovery::find_port_owner(port))
            .await
            .ok()
            .flatten()
    } else {
        None
    };

    HealthResult {
        ok,
        state: if ok { HealthState::Healthy } else { HealthState::Unhealthy },
        latency_ms,
        error,
        status,
        owner,
    }
}

async fn check_tcp(port: u16, timeout_ms: u64) -> (bool, Option<String>, Option<String>) {
    let attempt = TcpStream::connect(("127.0.0.1", port));
    match timeout(Duration::from_millis(timeout_ms), attempt).await {
        Ok(Ok(_)) => (true, None, Some("aberta".into())),
        Ok(Err(err)) => (false, Some(err.to_string()), None),
        Err(_) => (false, Some(format!("timeout apos {timeout_ms}ms")), None),
    }
}

async fn check_http(
    port: u16,
    config: &HealthConfig,
    timeout_ms: u64,
) -> (bool, Option<String>, Option<String>) {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()
    {
        Ok(client) => client,
        Err(err) => return (false, Some(err.to_string()), None),
    };

    let path = if config.path.starts_with('/') {
        config.path.clone()
    } else {
        format!("/{}", config.path)
    };
    let url = format!("http://127.0.0.1:{port}{path}");

    match client.get(&url).send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let expected = config.expect_status;
            let ok = if expected == 0 {
                status < 400
            } else {
                status == expected
            };
            if ok {
                (true, None, Some(status.to_string()))
            } else {
                (
                    false,
                    Some(format!("HTTP {status} (esperado {expected})")),
                    Some(status.to_string()),
                )
            }
        }
        Err(err) => (false, Some(err.to_string()), None),
    }
}

/// Monta o detalhe de saude para a interface.
pub fn detail(result: &HealthResult) -> HealthDetail {
    HealthDetail {
        latency_ms: result.latency_ms,
        error: result.error.clone(),
        status: result.status.clone(),
        owner: result.owner.clone(),
    }
}

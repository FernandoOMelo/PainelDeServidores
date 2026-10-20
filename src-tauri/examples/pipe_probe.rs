//! Verifica quantas requisicoes simultaneas o pipe aceita (modo byte).
//!
//!   cargo run --example pipe_probe

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::ClientOptions;

const PIPE: &str = r"\\.\pipe\docker_engine";

async fn request_short(path: &str) -> Result<String, String> {
    let mut client = ClientOptions::new()
        .open(PIPE)
        .map_err(|err| format!("erro {}", err.raw_os_error().unwrap_or(0)))?;

    let request = format!("GET {path} HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n");
    client
        .write_all(request.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    client.flush().await.map_err(|e| e.to_string())?;

    let mut raw = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        if raw.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        let n = client.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        raw.extend_from_slice(&buf[..n]);
    }
    Ok(format!("{} bytes", raw.len()))
}

#[tokio::main]
async fn main() {
    println!("=== 4 requisicoes SIMULTANEAS ===");
    let mut tarefas = Vec::new();
    for _ in 0..4 {
        tarefas.push(tokio::spawn(async {
            request_short("/v1.43/containers/gameshelfproject-api-1/json").await
        }));
    }
    for (n, tarefa) in tarefas.into_iter().enumerate() {
        match tarefa.await {
            Ok(Ok(info)) => println!("  req {}: ok ({info})", n + 1),
            Ok(Err(err)) => println!("  req {}: FALHOU -> {err}", n + 1),
            Err(err) => println!("  req {}: panic -> {err}", n + 1),
        }
    }

    println!("\n=== 8 requisicoes SIMULTANEAS ===");
    let mut tarefas = Vec::new();
    for _ in 0..8 {
        tarefas.push(tokio::spawn(async {
            request_short("/v1.43/containers/gameshelfproject-api-1/json").await
        }));
    }
    let mut ok = 0;
    for tarefa in tarefas.into_iter() {
        match tarefa.await {
            Ok(Ok(_)) => ok += 1,
            _ => {}
        }
    }
    println!("  {ok}/8 com sucesso");
}

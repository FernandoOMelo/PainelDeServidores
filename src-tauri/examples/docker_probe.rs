//! Teste manual da API do Docker em Rust.
//!
//!   cargo run --example docker_probe

#[tokio::main]
async fn main() {
    match painel_lib::docker::list_containers().await {
        Ok(linhas) => {
            println!("containers: {}", linhas.len());
            for linha in linhas.iter().take(5) {
                println!("  {} | {} | {}", linha.name, linha.state, linha.image);
            }
        }
        Err(err) => println!("ERRO ao listar: {err}"),
    }

    let (ok, version) = painel_lib::docker::availability().await;
    println!("daemon disponivel: {ok} ({version})");

    if let Ok(linhas) = painel_lib::docker::list_containers().await {
        if let Some(alvo) = linhas.iter().find(|c| c.state == "running") {
            match painel_lib::docker::inspect(&alvo.name).await {
                Ok(info) => println!(
                    "inspect {}: estado={} saude={:?} portas={:?}",
                    alvo.name, info.state, info.health, info.ports
                ),
                Err(err) => println!("ERRO no inspect: {err}"),
            }
            match painel_lib::docker::stats(&alvo.name).await {
                Ok(stats) => println!("stats {}: cpu={} mem={}", alvo.name, stats.cpu, stats.mem),
                Err(err) => println!("ERRO nas stats: {err}"),
            }
        }
    }
}

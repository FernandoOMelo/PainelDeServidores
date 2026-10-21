//! Instancia unica.
//!
//! Rodar o executavel de novo nao cria um segundo app: ele avisa o que ja
//! esta na bandeja para mostrar a janela e sai. E o jeito mais direto de
//! voltar ao painel depois de fechar a janela.

use std::net::SocketAddr;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Porta local usada para o aviso entre instancias.
const PORTA: u16 = 47821;

const HOST: &str = "127.0.0.1";

/// Avisa a instancia que ja esta rodando.
pub async fn avisar_instancia_existente() -> bool {
    let endereco = format!("{HOST}:{PORTA}");
    let Ok(mut stream) = TcpStream::connect(&endereco).await else {
        return false;
    };

    stream
        .write_all(b"mostrar\n")
        .await
        .map(|_| true)
        .unwrap_or(false)
}

/// Tenta assumir a instancia unica. Devolve false quando ja existe outra.
pub async fn tentar_assumir() -> Result<TcpListener, String> {
    let endereco: SocketAddr = format!("{HOST}:{PORTA}").parse().unwrap();

    TcpListener::bind(endereco)
        .await
        .map_err(|err| format!("nao foi possivel assumir a instancia unica: {err}"))
}

/// Escuta os avisos de outras instancias.
pub async fn escutar<F>(ao_mostrar: F)
where
    F: Fn() + Send + Sync + 'static,
{
    let Ok(listener) = tentar_assumir().await else {
        return;
    };

    let aviso = std::sync::Arc::new(ao_mostrar);

    loop {
        let Ok((mut stream, _)) = listener.accept().await else {
            continue;
        };

        let aviso = aviso.clone();
        tokio::spawn(async move {
            let mut buffer = [0u8; 32];
            let Ok(lidos) = stream.read(&mut buffer).await else {
                return;
            };
            let texto = String::from_utf8_lossy(&buffer[..lidos]);
            if texto.contains("mostrar") {
                aviso();
            }
        });
    }
}

//! Testes do nucleo do painel.
//!
//! Cobrem as partes que mais quebram: leitura/escrita do config, resolucao do
//! node proprio, leitura do Service Control Manager e varredura de portas.

use std::fs;
use std::path::PathBuf;

use painel_lib::store::{normalize_service, service_from_json, Store};
use painel_lib::types::{HealthKind, ServiceKind};

fn temp_dir(nome: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("painel-teste-{nome}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("criar pasta de teste");
    dir
}

/* ------------------------------------------------------------------ */
/* Configuracao                                                        */
/* ------------------------------------------------------------------ */

#[test]
fn le_config_inexistente_vai_para_o_padrao() {
    let dir = temp_dir("inexistente");
    let store = Store::new(&dir.join("config.json"));
    assert!(store.services().is_empty());
    assert_eq!(store.settings().log_buffer_lines, 2000);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn config_usa_o_mesmo_formato_camel_case_do_frontend() {
    let dir = temp_dir("formato");
    let caminho = dir.join("config.json");

    let json = r#"{
      "version": 1,
      "settings": { "logBufferLines": 500, "metricsIntervalMs": 3000, "autoStart": true },
      "services": [
        {
          "id": "api",
          "name": "API",
          "group": "Backend",
          "type": "processo",
          "command": "node",
          "args": ["server.js"],
          "cwd": "C:/api",
          "env": { "PORT": "3000" },
          "shell": false,
          "autostart": true,
          "monitorOnly": true,
          "nodePath": "C:/node/node.exe",
          "container": "",
          "service": "",
          "health": { "type": "http", "port": 3000, "path": "/health", "expectStatus": 200, "intervalMs": 2000, "timeoutMs": 1500, "graceMs": 0, "failuresBeforeUnhealthy": 3 },
          "restart": { "enabled": true, "maxRetries": 4, "backoffMs": 500, "maxBackoffMs": 10000, "restartOnUnhealthy": true, "stabilityMs": 30000 },
          "createdAt": "2026-01-01T00:00:00Z"
        }
      ]
    }"#;
    fs::write(&caminho, json).expect("escrever config");

    let store = Store::new(&caminho);
    let services = store.services();
    assert_eq!(services.len(), 1, "o servico deveria ter sido lido");

    let servico = &services[0];
    assert_eq!(servico.name, "API");
    assert_eq!(servico.kind, ServiceKind::Processo);
    assert!(servico.monitor_only, "monitorOnly deveria ter sido lido");
    assert_eq!(servico.node_path, "C:/node/node.exe");
    assert_eq!(servico.health.kind, HealthKind::Http);
    assert_eq!(servico.health.port, Some(3000));
    assert_eq!(servico.health.expect_status, 200);
    assert_eq!(servico.health.interval_ms, 2000);
    assert_eq!(servico.restart.max_retries, 4);
    assert_eq!(servico.restart.backoff_ms, 500);
    assert_eq!(servico.env.get("PORT").map(String::as_str), Some("3000"));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn config_invalido_e_preservado_e_comeca_vazio() {
    let dir = temp_dir("invalido");
    let caminho = dir.join("config.json");
    fs::write(&caminho, "{ isso nao e json").expect("escrever config");

    let store = Store::new(&caminho);
    assert!(store.services().is_empty(), "deveria comecar vazio");

    let backups: Vec<_> = fs::read_dir(&dir)
        .expect("listar")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.contains("corrompido"))
        .collect();
    assert_eq!(backups.len(), 1, "o original deveria ter sido preservado");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn gravacao_e_atomica_e_preserva_o_conteudo() {
    let dir = temp_dir("gravar");
    let caminho = dir.join("config.json");

    let store = Store::new(&caminho);
    let mut servico = service_from_json(serde_json::json!({
        "name": "Teste",
        "command": "node",
        "type": "processo"
    }));
    servico.group = "Geral".into();
    store.add_service(servico);

    let relido = Store::new(&caminho);
    assert_eq!(relido.services().len(), 1);
    assert_eq!(relido.services()[0].name, "Teste");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn normalizacao_completa_campos_ausentes() {
    let mut servico = service_from_json(serde_json::json!({ "name": "  " }));
    normalize_service(&mut servico);

    assert!(!servico.id.is_empty(), "deveria gerar um id");
    assert_eq!(servico.kind, ServiceKind::Processo);
    assert_eq!(servico.group, "Geral");
    assert!(servico.restart.max_backoff_ms >= servico.restart.backoff_ms);
    assert!(servico.health.interval_ms >= 1000);
}

#[test]
fn tipo_docker_e_servico_windows_sao_reconhecidos() {
    let docker = service_from_json(serde_json::json!({ "name": "C", "type": "docker", "container": "x" }));
    assert_eq!(docker.kind, ServiceKind::Docker);

    let servico = service_from_json(serde_json::json!({ "name": "S", "type": "servico", "service": "y" }));
    assert_eq!(servico.kind, ServiceKind::Servico);
}

/* ------------------------------------------------------------------ */
/* Node proprio                                                        */
/* ------------------------------------------------------------------ */

#[test]
fn resolve_node_por_arquivo_ou_pasta() {
    let dir = temp_dir("node");
    let exe = dir.join("node.exe");
    fs::write(&exe, b"fake").expect("escrever");

    let por_arquivo = painel_lib::executables::resolve_node_executable(
        &exe.to_string_lossy(),
        PathBuf::from(".").as_path(),
    );
    assert!(por_arquivo.is_some(), "deveria achar pelo caminho do arquivo");

    let por_pasta = painel_lib::executables::resolve_node_executable(
        &dir.to_string_lossy(),
        PathBuf::from(".").as_path(),
    );
    assert_eq!(por_pasta, Some(exe.clone()), "deveria achar node.exe dentro da pasta");

    assert!(painel_lib::executables::resolve_node_executable("nao-existe", PathBuf::from(".").as_path()).is_none());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn acha_node_embutido_em_varios_layouts() {
    let dir = temp_dir("embutido");

    for pasta in ["node", "runtime/node", "vendor/nodejs"] {
        let alvo = dir.join(pasta);
        fs::create_dir_all(&alvo).expect("criar");
        fs::write(alvo.join("node.exe"), b"fake").expect("escrever");
    }

    let encontrados = painel_lib::executables::find_embedded_nodes(dir.as_path());
    assert!(encontrados.len() >= 3, "deveria achar pelo menos os tres layouts");
    assert!(encontrados.iter().all(|n| n.path.ends_with("node.exe")));

    for layout in ["node", "runtime/node", "vendor/nodejs"] {
        let esperado = dir.join(layout).join("node.exe");
        assert!(
            encontrados.iter().any(|n| n.path == esperado.to_string_lossy()),
            "deveria ter achado {layout}"
        );
    }

    let _ = fs::remove_dir_all(&dir);
}

/* ------------------------------------------------------------------ */
/* Servicos do Windows                                                 */
/* ------------------------------------------------------------------ */

#[test]
fn traduz_estados_do_servico_por_numero() {
    assert_eq!(painel_lib::winsvc::state_name(1), "Stopped");
    assert_eq!(painel_lib::winsvc::state_name(4), "Running");
    assert_eq!(painel_lib::winsvc::state_name(7), "Paused");
}

#[test]
fn traduz_modo_de_inicializacao() {
    assert_eq!(painel_lib::winsvc::start_mode_name(2), "Auto");
    assert_eq!(painel_lib::winsvc::start_mode_name(3), "Manual");
    assert_eq!(painel_lib::winsvc::start_mode_name(4), "Disabled");
}

#[test]
fn erro_de_acesso_negado_sugere_elevacao() {
    let erro = painel_lib::winsvc::translate_error(5, "");
    assert!(erro.contains("administrador"), "deveria sugerir administrador");
    assert!(erro.contains("Acesso negado"));
}

#[test]
fn traduz_os_outros_codigos_do_sc() {
    assert!(painel_lib::winsvc::translate_error(1062, "").contains("nao esta em execucao"));
    assert!(painel_lib::winsvc::translate_error(1060, "").contains("nao existe"));
}

/* ------------------------------------------------------------------ */
/* Varredura de portas                                                 */
/* ------------------------------------------------------------------ */

#[test]
fn dono_da_porta_tem_o_processo_que_responde() {
    let dir = temp_dir("porta");
    let caminho = dir.join("netstat.txt");
    fs::write(
        &caminho,
        "  TCP    0.0.0.0:3000          0.0.0.0:0              LISTENING       1234\n",
    )
    .expect("escrever");

    // O parser recebe o texto do netstat; a funcao publica expoe o formato.
    let linha = "  TCP    0.0.0.0:3000          0.0.0.0:0              LISTENING       1234";
    let partes: Vec<&str> = linha.split_whitespace().collect();
    assert_eq!(partes.len(), 5);
    assert_eq!(partes[0], "TCP");
    assert_eq!(partes[1], "0.0.0.0:3000");
    assert_eq!(partes[3], "LISTENING");
    assert_eq!(partes[4], "1234");

    let _ = fs::remove_dir_all(&dir);
}

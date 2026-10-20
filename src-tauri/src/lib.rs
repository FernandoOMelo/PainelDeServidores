//! Painel de Servidores - aplicacao desktop (Tauri).
//!
//! O motor roda no processo principal: cada servico tem um runner que
//! cuida do ciclo de vida, dos logs e da monitoracao.

mod autostart;
mod commands;
pub mod discovery;
pub mod docker;
pub mod executables;
pub mod health;
mod manager;
pub mod metrics;
mod service;
pub mod store;
pub mod types;
pub mod winsvc;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent, WindowEvent};

use crate::commands::AppState;
use crate::store::Store;
use crate::types::AppPaths;

/// Caminho da raiz do app: onde ficam os recursos e a base para resolver
/// caminhos relativos dos servicos.
fn app_root() -> PathBuf {
    let exe = std::env::current_exe().ok();
    if cfg!(debug_assertions) {
        // .../src-tauri/target/debug/painel-servidores.exe -> raiz do projeto
        exe.and_then(|exe| {
            exe.parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.parent())
                .and_then(|p| p.parent())
                .map(|p| p.to_path_buf())
        })
        .unwrap_or_else(|| PathBuf::from("."))
    } else {
        // Empacotado: a pasta do executavel.
        exe.and_then(|exe| exe.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| PathBuf::from("."))
    }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::servicos_listar,
            commands::servicos_estado,
            commands::servicos_criar,
            commands::servicos_atualizar,
            commands::servicos_remover,
            commands::servicos_iniciar,
            commands::servicos_parar,
            commands::servicos_reiniciar,
            commands::servicos_logs,
            commands::servicos_limpar_logs,
            commands::servico_verificar_saude,
            commands::config_obter,
            commands::config_definir,
            commands::descoberta_varredura,
            commands::docker_status,
            commands::docker_containers,
            commands::servico_listar,
            commands::node_versao,
            commands::node_descobrir,
            commands::app_reiniciar_como_admin,
            commands::app_elevado,
            commands::app_esconder_janela,
            commands::app_inicio_automatico,
            commands::app_definir_inicio_automatico,
            commands::app_info,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let root = app_root();

            // Configuracao e logs: dentro do projeto em desenvolvimento, na
            // pasta de dados do usuario quando empacotado (a pasta do app e
            // somente leitura).
            let data_dir = handle
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| root.join("dados"));

            let config_path = if cfg!(debug_assertions) {
                root.join("config.local.json")
            } else {
                data_dir.join("config.json")
            };
            let logs_dir = if cfg!(debug_assertions) {
                root.join("logs")
            } else {
                data_dir.join("logs")
            };
            let _ = std::fs::create_dir_all(&logs_dir);

            let store = Arc::new(Store::new(&config_path));
            let (manager, rx) = manager::create_manager(store.clone(), root.clone());

            app.manage(AppState {
                manager: manager.clone(),
                paths: AppPaths {
                    config: config_path.to_string_lossy().to_string(),
                    logs: logs_dir.to_string_lossy().to_string(),
                    user_data: data_dir.to_string_lossy().to_string(),
                },
                app_root: root,
                window: parking_lot::Mutex::new(None),
            });

            // Bandeja: o app continua monitorando com a janela fechada.
            let abrir = MenuItem::with_id(app, "abrir", "Abrir painel", true, None::<&str>)?;
            let iniciar = MenuItem::with_id(app, "iniciar", "Iniciar todos", true, None::<&str>)?;
            let parar = MenuItem::with_id(app, "parar", "Parar todos", true, None::<&str>)?;
            let autostart =
                MenuItem::with_id(app, "autostart", "Iniciar com o Windows", true, None::<&str>)?;
            let sair = MenuItem::with_id(app, "sair", "Sair", true, None::<&str>)?;
            let separador = PredefinedMenuItem::separator(app)?;

            let menu = Menu::with_items(
                app,
                &[
                    &abrir,
                    &separador,
                    &iniciar,
                    &parar,
                    &separador,
                    &autostart,
                    &separador,
                    &sair,
                ],
            )?;

            TrayIconBuilder::with_id("principal")
                .icon(app.default_window_icon().cloned().unwrap())
                .tooltip("Painel de Servidores")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "abrir" => {
                        abrir_janela(app);
                    }
                    "iniciar" => {
                        let manager = app.state::<AppState>().manager.clone();
                        tauri::async_runtime::spawn(async move {
                            for service in manager.list() {
                                manager.start(&service.id).await;
                            }
                        });
                    }
                    "parar" => {
                        let manager = app.state::<AppState>().manager.clone();
                        tauri::async_runtime::spawn(async move {
                            for service in manager.list() {
                                manager.stop(&service.id).await;
                            }
                        });
                    }
                    "autostart" => {
                        let enabled = !autostart::is_enabled();
                        autostart::set_enabled(enabled);
                    }
                    "sair" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { .. } = event {
                        abrir_janela(tray.app_handle());
                    }
                })
                .build(app)?;

            // Eventos internos -> interface.
            let manager_for_pump = manager.clone();
            let app_for_pump = handle.clone();
            tauri::async_runtime::spawn(async move {
                manager::pump_events(rx, manager_for_pump, app_for_pump).await;
            });

            // Metricas: so com a interface aberta.
            let manager_for_metrics = manager.clone();
            let app_for_metrics = handle.clone();
            tauri::async_runtime::spawn(async move {
                manager::metrics_loop(manager_for_metrics, app_for_metrics).await;
            });

            // Comeca: registra os servicos e inicia os que pedem autostart.
            let manager_for_init = manager.clone();
            tauri::async_runtime::spawn(async move {
                manager_for_init.init().await;
            });

            // --hidden: so na bandeja. A WebView2 so e criada quando o
            // usuario pede a janela - ela sozinha custa ~350 MB.
            let hidden = std::env::args().any(|arg| arg == "--hidden");
            if !hidden {
                abrir_janela(app.handle());
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Fechar a janela envia o app para a bandeja: ele continua
                // monitorando os servicos em segundo plano.
                api.prevent_close();
                let _ = window.hide();
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    let manager = state.manager.clone();
                    tauri::async_runtime::spawn(async move {
                        manager.set_window_active(false).await;
                    });
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("falha ao iniciar o app")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                // Encerra os processos que o painel iniciou.
                if let Some(state) = app.try_state::<AppState>() {
                    let manager = state.manager.clone();
                    tauri::async_runtime::spawn(async move {
                        manager.shutdown().await;
                    });
                }
            }
        });
}

/// Cria a janela do painel (sob demanda) e a mostra em primeiro plano.
///
/// A janela nao existe enquanto o app esta so na bandeja: manter a WebView2
/// aberta custaria ~350 MB sem nenhum ganho para quem so quer o icone.
pub fn abrir_janela(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<commands::AppState>() else {
        return;
    };

    let mut slot = state.window.lock();
    if let Some(window) = slot.as_ref() {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    let caminho = state.paths.config.clone();
    let _ = caminho;

    let builder = tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Painel de Servidores")
    .inner_size(1320.0, 860.0)
    .min_inner_size(960.0, 600.0)
    .background_color(tauri::window::Color(0x0b, 0x0f, 0x16, 0xff))
    .resizable(true);

    match builder.build() {
        Ok(window) => {
            let _ = window.show();
            let _ = window.set_focus();
            *slot = Some(window);
        }
        Err(err) => eprintln!("[app] falha ao criar a janela: {err}"),
    }
}

/// Reexportado para o modulo principal.
pub use types::AppEvent;

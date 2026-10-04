mod autostart;
mod local_hub;
mod overlay;
mod ptt;
mod secure_store;
mod tray_activity;
mod tunnel;
mod updater;

use local_hub::LocalHubHandle;
use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tunnel::TunnelHandle;

struct LocalNodeState {
    handle: tokio::sync::Mutex<Option<LocalHubHandle>>,
    tunnel: tokio::sync::Mutex<Option<TunnelHandle>>,
    public_origin: tokio::sync::Mutex<Option<String>>,
    active_provider: tokio::sync::Mutex<Option<tunnel::TunnelProvider>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalNodeInfoDto {
    origin: String,
    lan_origins: Vec<String>,
    public_origin: Option<String>,
    tunnel_error: Option<String>,
}

async fn ensure_node_and_tunnel(
    app: &tauri::AppHandle,
    state: &LocalNodeState,
    force_restart_tunnel: bool,
    provider: Option<String>,
    ngrok_auth_token: Option<String>,
    zrok_token: Option<String>,
) -> Result<LocalNodeInfoDto, String> {
    let mut handle = state.handle.lock().await;
    if handle.is_none() {
        let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
        *handle = Some(local_hub::start(dir.join("node.sqlite")).await?);
    }
    let port = handle.as_ref().map(LocalHubHandle::port).unwrap_or_default();
    drop(handle);

    let origin = format!("http://127.0.0.1:{port}");
    let lan_origins = local_hub::lan_origins(port);

    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let (stored_provider, stored_ngrok, stored_zrok) = tunnel::load_tunnel_prefs(&dir);
    let provider = provider
        .as_deref()
        .map(tunnel::TunnelProvider::parse)
        .unwrap_or(stored_provider);
    let ngrok_token = ngrok_auth_token.unwrap_or(stored_ngrok);
    let zrok = zrok_token.unwrap_or(stored_zrok);

    let active = *state.active_provider.lock().await;
    let existing = state.public_origin.lock().await.clone();
    let provider_changed = active.is_some_and(|current| current != provider);
    let url_mismatched = existing.as_ref().is_some_and(|url| !provider_matches_url(provider, url));
    let must_restart = force_restart_tunnel || provider_changed || url_mismatched;

    if must_restart {
        let mut tunnel_guard = state.tunnel.lock().await;
        *tunnel_guard = None;
        let mut public = state.public_origin.lock().await;
        *public = None;
        *state.active_provider.lock().await = None;
    } else if existing.is_some() {
        return Ok(LocalNodeInfoDto {
            origin,
            lan_origins,
            public_origin: existing,
            tunnel_error: None,
        });
    }

    let started = tokio::task::spawn_blocking(move || {
        tunnel::start_tunnel(&dir, port, provider, &ngrok_token, &zrok)
    })
    .await;

    match started {
        Ok(Ok((tunnel_handle, info))) => {
            *state.tunnel.lock().await = Some(tunnel_handle);
            *state.public_origin.lock().await = Some(info.public_origin.clone());
            *state.active_provider.lock().await = Some(provider);
            Ok(LocalNodeInfoDto {
                origin,
                lan_origins,
                public_origin: Some(info.public_origin),
                tunnel_error: None,
            })
        }
        Ok(Err(err)) => Ok(LocalNodeInfoDto {
            origin,
            lan_origins,
            public_origin: None,
            tunnel_error: Some(err),
        }),
        Err(err) => Ok(LocalNodeInfoDto {
            origin,
            lan_origins,
            public_origin: None,
            tunnel_error: Some(format!("Tunnel task failed: {err}")),
        }),
    }
}

fn provider_matches_url(provider: tunnel::TunnelProvider, url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    match provider {
        tunnel::TunnelProvider::Cloudflare => {
            lower.contains("trycloudflare.com") || lower.contains("cfargotunnel.com")
        }
        tunnel::TunnelProvider::Ngrok => lower.contains("ngrok"),
        tunnel::TunnelProvider::LocalhostRun => lower.contains("localhost.run"),
        tunnel::TunnelProvider::Pinggy => lower.contains("pinggy"),
        tunnel::TunnelProvider::Bore => lower.contains("bore.pub"),
        tunnel::TunnelProvider::Zrok => lower.contains("zrok.io"),
    }
}

/// Starts this computer's peer node once and returns its addresses (+ public tunnel).
#[tauri::command]
async fn start_local_sync_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalNodeState>,
    provider: Option<String>,
    ngrok_auth_token: Option<String>,
    zrok_token: Option<String>,
) -> Result<LocalNodeInfoDto, String> {
    ensure_node_and_tunnel(&app, &state, false, provider, ngrok_auth_token, zrok_token).await
}

/// Restarts the public tunnel with the selected provider.
#[tauri::command]
async fn restart_public_tunnel(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalNodeState>,
    provider: Option<String>,
    ngrok_auth_token: Option<String>,
    zrok_token: Option<String>,
) -> Result<LocalNodeInfoDto, String> {
    ensure_node_and_tunnel(&app, &state, true, provider, ngrok_auth_token, zrok_token).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(LocalNodeState {
            handle: tokio::sync::Mutex::new(None),
            tunnel: tokio::sync::Mutex::new(None),
            public_origin: tokio::sync::Mutex::new(None),
            active_provider: tokio::sync::Mutex::new(None),
        })
        .manage(Arc::new(ptt::PttWatchState::default()))
        .manage(secure_store::SecureVaultState::default())
        .invoke_handler(tauri::generate_handler![
            start_local_sync_server,
            restart_public_tunnel,
            updater::install_update,
            autostart::get_autostart_enabled,
            autostart::set_autostart_enabled,
            tray_activity::set_tray_speaking,
            ptt::start_ptt_watch,
            ptt::stop_ptt_watch,
            ptt::set_ptt_vk,
            ptt::set_voice_hotkey_vks,
            overlay::show_voice_overlay,
            overlay::hide_voice_overlay,
            overlay::close_voice_overlay,
            overlay::focus_voice_overlay,
            secure_store::secure_vault_load,
            secure_store::secure_vault_save
        ])
        .setup(|app| {
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Registers schemes for installed + `tauri dev` so drift:// opens this build.
                let _ = app.deep_link().register_all();
            }

            let show = MenuItem::with_id(app, "show", "Открыть Drift", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let _tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("missing window icon"))
                .tooltip("Drift")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            tray_activity::spawn_tray_flash(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Drift");
}

mod autostart;
mod local_hub;
mod tray_activity;
mod tunnel;
mod updater;

use local_hub::LocalHubHandle;
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

    if force_restart_tunnel {
        let mut tunnel_guard = state.tunnel.lock().await;
        *tunnel_guard = None;
        let mut public = state.public_origin.lock().await;
        *public = None;
    }

    let existing = state.public_origin.lock().await.clone();
    if existing.is_some() && !force_restart_tunnel {
        return Ok(LocalNodeInfoDto {
            origin,
            lan_origins,
            public_origin: existing,
            tunnel_error: None,
        });
    }

    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let started =
        tokio::task::spawn_blocking(move || tunnel::start_quick_tunnel(&dir, port)).await;

    match started {
        Ok(Ok((tunnel_handle, info))) => {
            *state.tunnel.lock().await = Some(tunnel_handle);
            *state.public_origin.lock().await = Some(info.public_origin.clone());
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

/// Starts this computer's peer node once and returns its addresses (+ auto Cloudflare tunnel).
#[tauri::command]
async fn start_local_sync_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalNodeState>,
) -> Result<LocalNodeInfoDto, String> {
    ensure_node_and_tunnel(&app, &state, false).await
}

/// Restarts the Cloudflare Quick Tunnel.
#[tauri::command]
async fn restart_public_tunnel(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalNodeState>,
) -> Result<LocalNodeInfoDto, String> {
    ensure_node_and_tunnel(&app, &state, true).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(LocalNodeState {
            handle: tokio::sync::Mutex::new(None),
            tunnel: tokio::sync::Mutex::new(None),
            public_origin: tokio::sync::Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            start_local_sync_server,
            restart_public_tunnel,
            updater::install_update,
            autostart::get_autostart_enabled,
            autostart::set_autostart_enabled,
            tray_activity::set_tray_speaking
        ])
        .setup(|app| {
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
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Drift");
}

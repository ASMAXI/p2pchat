mod local_hub;

use local_hub::{LocalHubHandle, LocalSyncServerInfo};
use tauri::Manager;

struct LocalNodeState {
    handle: tokio::sync::Mutex<Option<LocalHubHandle>>,
}

/// Starts this computer's peer node once and returns its addresses.
#[tauri::command]
async fn start_local_sync_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalNodeState>,
) -> Result<LocalSyncServerInfo, String> {
    let mut handle = state.handle.lock().await;
    if handle.is_none() {
        let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
        *handle = Some(local_hub::start(dir.join("node.sqlite")).await?);
    }
    let port = handle.as_ref().map(LocalHubHandle::port).unwrap_or_default();
    Ok(LocalSyncServerInfo {
        origin: format!("http://127.0.0.1:{port}"),
        lan_origins: local_hub::lan_origins(port),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(LocalNodeState {
            handle: tokio::sync::Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![start_local_sync_server])
        .run(tauri::generate_context!())
        .expect("error while running P2PChat");
}

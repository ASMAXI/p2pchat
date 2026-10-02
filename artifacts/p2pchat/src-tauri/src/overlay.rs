//! Always-on-top mini voice overlay window (TeamSpeak / Discord style).

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "voice-overlay";

#[tauri::command]
pub async fn show_voice_overlay(app: AppHandle) -> Result<(), String> {
    if app.get_webview_window(LABEL).is_some() {
        if let Some(win) = app.get_webview_window(LABEL) {
            let _ = win.show();
            let _ = win.set_always_on_top(true);
        }
        return Ok(());
    }

    let url = WebviewUrl::App("/#/voice-overlay".into());
    WebviewWindowBuilder::new(&app, LABEL, url)
        .title("Drift Voice")
        .inner_size(260.0, 340.0)
        .position(16.0, 16.0)
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(true)
        .build()
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn hide_voice_overlay(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.hide();
    }
    Ok(())
}

#[tauri::command]
pub async fn close_voice_overlay(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.close();
    }
    Ok(())
}

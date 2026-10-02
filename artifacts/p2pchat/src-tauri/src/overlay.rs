//! Always-on-top mini voice overlay (TeamSpeak / Discord style).

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "voice-overlay";

#[tauri::command]
pub async fn show_voice_overlay(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.set_always_on_top(true);
        let _ = win.show();
        let _ = win.set_always_on_top(true);
        return Ok(());
    }

    // Query param — hash routes are ignored by pathname-based wouter and showed Home before.
    let url = WebviewUrl::App("/index.html?voiceOverlay=1".into());
    let window = WebviewWindowBuilder::new(&app, LABEL, url)
        .title("Drift Voice")
        .inner_size(240.0, 280.0)
        .min_inner_size(160.0, 120.0)
        .position(12.0, 12.0)
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(true)
        .build()
        .map_err(|err| err.to_string())?;

    let _ = window.set_always_on_top(true);
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

/// Re-assert topmost (call when joining voice / settings toggle).
#[tauri::command]
pub async fn focus_voice_overlay(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.set_always_on_top(true);
        let _ = win.show();
    }
    Ok(())
}

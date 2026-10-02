//! Always-on-top mini voice overlay (TeamSpeak / Discord style).
//!
//! `set_always_on_top` alone loses the fight against games, so on Windows we
//! also push WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW and re-assert
//! HWND_TOPMOST. Exclusive-fullscreen games still cannot be covered — only
//! windowed / borderless ones.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const LABEL: &str = "voice-overlay";

#[cfg(windows)]
#[link(name = "user32")]
unsafe extern "system" {
    fn SetWindowPos(
        hwnd: isize,
        insert_after: isize,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        flags: u32,
    ) -> i32;
    fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
    fn SetWindowLongPtrW(hwnd: isize, index: i32, new_long: isize) -> isize;
}

#[cfg(windows)]
const GWL_EXSTYLE: i32 = -20;
#[cfg(windows)]
const WS_EX_TOPMOST: isize = 0x0000_0008;
#[cfg(windows)]
const WS_EX_TOOLWINDOW: isize = 0x0000_0080;
#[cfg(windows)]
const WS_EX_NOACTIVATE: isize = 0x0800_0000;
#[cfg(windows)]
const HWND_TOPMOST: isize = -1;
#[cfg(windows)]
const SWP_NOSIZE: u32 = 0x0001;
#[cfg(windows)]
const SWP_NOMOVE: u32 = 0x0002;
#[cfg(windows)]
const SWP_NOACTIVATE: u32 = 0x0010;
#[cfg(windows)]
const SWP_SHOWWINDOW: u32 = 0x0040;

fn force_topmost(window: &WebviewWindow) {
    let _ = window.set_always_on_top(true);
    #[cfg(windows)]
    {
        if let Ok(handle) = window.hwnd() {
            let hwnd = handle.0 as isize;
            unsafe {
                let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                SetWindowLongPtrW(
                    hwnd,
                    GWL_EXSTYLE,
                    ex | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                );
                SetWindowPos(
                    hwnd,
                    HWND_TOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            }
        }
    }
}

#[tauri::command]
pub async fn show_voice_overlay(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.show();
        force_topmost(&win);
        return Ok(());
    }

    // Query param — hash routes are ignored by the pathname-based router.
    let url = WebviewUrl::App("/index.html?voiceOverlay=1".into());
    let window = WebviewWindowBuilder::new(&app, LABEL, url)
        .title("Drift Voice")
        .inner_size(190.0, 110.0)
        .min_inner_size(120.0, 48.0)
        .position(12.0, 12.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(true)
        .shadow(false)
        .build()
        .map_err(|err| err.to_string())?;

    force_topmost(&window);
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

/// Re-assert topmost (called periodically while in a voice channel).
#[tauri::command]
pub async fn focus_voice_overlay(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.show();
        force_topmost(&win);
    }
    Ok(())
}

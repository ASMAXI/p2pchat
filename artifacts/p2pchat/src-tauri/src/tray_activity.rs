//! Tray activity indicator — flash when someone is speaking in voice.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;

static SPEAKING: AtomicBool = AtomicBool::new(false);
static FLASH_ON: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn set_tray_speaking(app: AppHandle, speaking: bool) -> Result<(), String> {
  SPEAKING.store(speaking, Ordering::SeqCst);
  if !speaking {
    FLASH_ON.store(false, Ordering::SeqCst);
    if let Some(tray) = app.tray_by_id("main") {
      let _ = tray.set_icon(app.default_window_icon().cloned());
      let _ = tray.set_tooltip(Some("Drift"));
    }
  } else if let Some(tray) = app.tray_by_id("main") {
    let _ = tray.set_tooltip(Some("Drift · кто-то говорит"));
  }
  Ok(())
}

pub fn spawn_tray_flash(app: AppHandle) {
  std::thread::spawn(move || loop {
    std::thread::sleep(std::time::Duration::from_millis(550));
    if !SPEAKING.load(Ordering::SeqCst) {
      continue;
    }
    let on = !FLASH_ON.load(Ordering::SeqCst);
    FLASH_ON.store(on, Ordering::SeqCst);
    let Some(tray) = app.tray_by_id("main") else { continue };
    if on {
      // Alternate tooltip pulse; icon swap without second asset keeps it simple.
      let _ = tray.set_tooltip(Some("Drift · 🔊 говорят"));
    } else {
      let _ = tray.set_tooltip(Some("Drift · кто-то говорит"));
    }
  });
}

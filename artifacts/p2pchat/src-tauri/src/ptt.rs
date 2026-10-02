//! Global PTT key watch (Windows GetAsyncKeyState). Emits ptt-down / ptt-up.

use std::{
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

use tauri::{AppHandle, Emitter, State};

#[cfg(windows)]
#[link(name = "user32")]
unsafe extern "system" {
    fn GetAsyncKeyState(v_key: i32) -> i16;
}

pub struct PttWatchState {
    running: AtomicBool,
    vk: AtomicU32,
}

impl Default for PttWatchState {
    fn default() -> Self {
        Self {
            running: AtomicBool::new(false),
            vk: AtomicU32::new(0x20),
        }
    }
}

#[tauri::command]
pub fn start_ptt_watch(app: AppHandle, state: State<'_, Arc<PttWatchState>>, vk: u32) -> Result<(), String> {
    state.vk.store(vk, Ordering::SeqCst);
    if state.running.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let flag = Arc::clone(&state);
    let app_handle = app.clone();
    thread::spawn(move || {
        let mut was_down = false;
        while flag.running.load(Ordering::SeqCst) {
            let code = flag.vk.load(Ordering::SeqCst) as i32;
            let down = {
                #[cfg(windows)]
                {
                    unsafe { GetAsyncKeyState(code) as u16 & 0x8000 != 0 }
                }
                #[cfg(not(windows))]
                {
                    let _ = code;
                    false
                }
            };
            if down && !was_down {
                let _ = app_handle.emit("ptt-down", ());
            } else if !down && was_down {
                let _ = app_handle.emit("ptt-up", ());
            }
            was_down = down;
            thread::sleep(Duration::from_millis(25));
        }
        if was_down {
            let _ = app_handle.emit("ptt-up", ());
        }
    });
    Ok(())
}

#[tauri::command]
pub fn stop_ptt_watch(state: State<'_, Arc<PttWatchState>>) -> Result<(), String> {
    state.running.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn set_ptt_vk(state: State<'_, Arc<PttWatchState>>, vk: u32) -> Result<(), String> {
    state.vk.store(vk, Ordering::SeqCst);
    Ok(())
}

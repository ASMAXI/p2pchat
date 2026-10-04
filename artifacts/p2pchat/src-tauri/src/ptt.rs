//! Global voice hotkey watch (Windows GetAsyncKeyState).
//! Emits ptt-down / ptt-up (hold) and mute / deafen toggles (edge).

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
    mute_vk: AtomicU32,
    deafen_vk: AtomicU32,
}

impl Default for PttWatchState {
    fn default() -> Self {
        Self {
            running: AtomicBool::new(false),
            vk: AtomicU32::new(0x20),
            mute_vk: AtomicU32::new(0),
            deafen_vk: AtomicU32::new(0),
        }
    }
}

fn key_down(code: i32) -> bool {
    if code == 0 {
        return false;
    }
    #[cfg(windows)]
    {
        unsafe { GetAsyncKeyState(code) as u16 & 0x8000 != 0 }
    }
    #[cfg(not(windows))]
    {
        let _ = code;
        false
    }
}

#[tauri::command]
pub fn start_ptt_watch(
    app: AppHandle,
    state: State<'_, Arc<PttWatchState>>,
    vk: u32,
    mute_vk: Option<u32>,
    deafen_vk: Option<u32>,
) -> Result<(), String> {
    state.vk.store(vk, Ordering::SeqCst);
    if let Some(code) = mute_vk {
        state.mute_vk.store(code, Ordering::SeqCst);
    }
    if let Some(code) = deafen_vk {
        state.deafen_vk.store(code, Ordering::SeqCst);
    }
    if state.running.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let flag = Arc::clone(&state);
    let app_handle = app.clone();
    thread::spawn(move || {
        let mut ptt_was_down = false;
        let mut mute_was_down = false;
        let mut deafen_was_down = false;
        while flag.running.load(Ordering::SeqCst) {
            let ptt_code = flag.vk.load(Ordering::SeqCst) as i32;
            let mute_code = flag.mute_vk.load(Ordering::SeqCst) as i32;
            let deafen_code = flag.deafen_vk.load(Ordering::SeqCst) as i32;

            let ptt_down = key_down(ptt_code);
            if ptt_code != 0 {
                if ptt_down && !ptt_was_down {
                    let _ = app_handle.emit("ptt-down", ());
                } else if !ptt_down && ptt_was_down {
                    let _ = app_handle.emit("ptt-up", ());
                }
                ptt_was_down = ptt_down;
            } else if ptt_was_down {
                let _ = app_handle.emit("ptt-up", ());
                ptt_was_down = false;
            }

            let mute_down = key_down(mute_code);
            if mute_code != 0 && mute_code != ptt_code && mute_down && !mute_was_down {
                let _ = app_handle.emit("hotkey-mute-toggle", ());
            }
            mute_was_down = mute_down;

            let deafen_down = key_down(deafen_code);
            if deafen_code != 0
                && deafen_code != ptt_code
                && deafen_code != mute_code
                && deafen_down
                && !deafen_was_down
            {
                let _ = app_handle.emit("hotkey-deafen-toggle", ());
            }
            deafen_was_down = deafen_down;

            thread::sleep(Duration::from_millis(25));
        }
        if ptt_was_down {
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

#[tauri::command]
pub fn set_voice_hotkey_vks(
    state: State<'_, Arc<PttWatchState>>,
    ptt_vk: u32,
    mute_vk: u32,
    deafen_vk: u32,
) -> Result<(), String> {
    state.vk.store(ptt_vk, Ordering::SeqCst);
    state.mute_vk.store(mute_vk, Ordering::SeqCst);
    state.deafen_vk.store(deafen_vk, Ordering::SeqCst);
    Ok(())
}

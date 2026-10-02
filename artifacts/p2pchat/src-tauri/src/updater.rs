//! Self-update: download with progress, wait for install after exit, relaunch.

use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

const ALLOWED_PREFIXES: &[&str] = &[
    "https://github.com/ASMAXI/",
    "https://objects.githubusercontent.com/",
    "https://release-assets.githubusercontent.com/",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    loaded: u64,
    total: Option<u64>,
    phase: &'static str,
}

fn installer_path(url: &str) -> Result<PathBuf, String> {
    let name = url
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or("Некорректная ссылка на установщик")?;
    let lower = name.to_ascii_lowercase();
    if !(lower.ends_with(".exe") || lower.ends_with(".msi")) {
        return Err("Установщик должен быть .exe или .msi".into());
    }
    let dir = std::env::temp_dir().join("drift-update");
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join(name))
}

fn emit_progress(app: &AppHandle, loaded: u64, total: Option<u64>, phase: &'static str) {
    let _ = app.emit(
        "update-progress",
        UpdateProgress {
            loaded,
            total,
            phase,
        },
    );
}

fn download(url: &str, dest: &PathBuf, app: &AppHandle) -> Result<(), String> {
    emit_progress(app, 0, None, "download");
    let response = ureq::get(url)
        .timeout(Duration::from_secs(600))
        .call()
        .map_err(|err| format!("Не удалось скачать обновление: {err}"))?;
    let total = response
        .header("Content-Length")
        .and_then(|value| value.parse::<u64>().ok());
    let mut reader = response.into_reader();
    let mut file = File::create(dest).map_err(|err| err.to_string())?;
    let mut buffer = [0u8; 64 * 1024];
    let mut loaded = 0u64;
    loop {
        let read = reader.read(&mut buffer).map_err(|err| err.to_string())?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read]).map_err(|err| err.to_string())?;
        loaded += read as u64;
        emit_progress(app, loaded, total, "download");
    }
    // Guard against truncated HTML error pages saved as .exe
    if loaded < 500_000 {
        let _ = std::fs::remove_file(dest);
        return Err(format!(
            "Файл обновления слишком маленький ({loaded} байт) — вероятно ошибка скачивания"
        ));
    }
    Ok(())
}

fn quote_cmd(path: &Path) -> String {
    format!("\"{}\"", path.to_string_lossy().replace('"', ""))
}

/// After this process exits: run installer, then start Drift again from the same path.
fn spawn_deferred_install(installer: &Path, app_exe: &Path) -> Result<(), String> {
    let dir = std::env::temp_dir().join("drift-update");
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let script = dir.join("apply-update.cmd");
    let is_msi = installer
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("msi"));

    let install_line = if is_msi {
        format!(
            "msiexec /i {} /qn /norestart REINSTALL=ALL REINSTALLMODE=vomus",
            quote_cmd(installer)
        )
    } else {
        // Tauri NSIS: silent in-place upgrade (no /R — we relaunch ourselves).
        format!("{} /S", quote_cmd(installer))
    };

    let contents = format!(
        "@echo off\r\n\
         rem Wait until Drift.exe unlocks its files\r\n\
         ping 127.0.0.1 -n 4 >nul\r\n\
         {install_line}\r\n\
         if errorlevel 1 (\r\n\
           ping 127.0.0.1 -n 2 >nul\r\n\
           {install_line}\r\n\
         )\r\n\
         ping 127.0.0.1 -n 2 >nul\r\n\
         start \"\" {}\r\n\
         del \"%~f0\"\r\n",
        quote_cmd(app_exe)
    );
    std::fs::write(&script, contents).map_err(|err| err.to_string())?;

    Command::new("cmd.exe")
        .args(["/C", "start", "", "/MIN", &script.to_string_lossy()])
        .spawn()
        .map_err(|err| format!("Не удалось запланировать установку: {err}"))?;
    Ok(())
}

fn launch_and_exit(app: &AppHandle, dest: &PathBuf) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|err| err.to_string())?;
    emit_progress(app, 0, None, "install");
    spawn_deferred_install(dest, &exe)?;
    emit_progress(app, 1, Some(1), "done");
    // Give the helper a moment to start, then unlock our binary.
    std::thread::sleep(Duration::from_millis(400));
    app.exit(0);
    Ok(())
}

/// Downloads the installer with progress events, schedules install after exit.
#[tauri::command]
pub async fn install_update(app: AppHandle, url: String) -> Result<(), String> {
    if !ALLOWED_PREFIXES.iter().any(|prefix| url.starts_with(prefix)) {
        return Err("Обновления скачиваются только с GitHub Releases ASMAXI".into());
    }
    let dest = installer_path(&url)?;
    let target = dest.clone();
    let app_dl = app.clone();
    tokio::task::spawn_blocking(move || download(&url, &target, &app_dl))
        .await
        .map_err(|err| err.to_string())??;
    launch_and_exit(&app, &dest)
}

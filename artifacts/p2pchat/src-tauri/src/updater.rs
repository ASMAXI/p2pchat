//! Self-update: download with progress events, passive install, relaunch same app.

use std::{
    fs::File,
    io::{Read, Write},
    path::PathBuf,
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
    Ok(())
}

fn relaunch_exe() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|err| err.to_string())
}

fn launch_and_exit(app: &AppHandle, dest: &PathBuf) -> Result<(), String> {
    let exe = relaunch_exe()?;
    let is_msi = dest
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("msi"));

    emit_progress(app, 0, None, "install");

    if is_msi {
        // Upgrade in place; do not let msiexec restart a random shortcut.
        Command::new("msiexec")
            .args([
                "/i",
                &dest.to_string_lossy(),
                "/passive",
                "/norestart",
                "REINSTALL=ALL",
                "REINSTALLMODE=vomus",
            ])
            .spawn()
            .map_err(|err| format!("Не удалось запустить установщик: {err}"))?;
        std::thread::sleep(Duration::from_secs(2));
        Command::new(&exe)
            .spawn()
            .map_err(|err| format!("Не удалось перезапустить Drift: {err}"))?;
    } else {
        // NSIS (Tauri): passive UI + relaunch registered app after upgrade.
        Command::new(dest)
            .args(["/P", "/R"])
            .spawn()
            .map_err(|err| format!("Не удалось запустить установщик: {err}"))?;
    }

    emit_progress(app, 1, Some(1), "done");
    app.exit(0);
    Ok(())
}

/// Downloads the installer with progress events, starts it and exits the app.
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

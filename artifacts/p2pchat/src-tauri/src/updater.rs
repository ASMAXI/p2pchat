//! Self-update without the Tauri updater plugin (no signing keys needed):
//! download the installer from GitHub Releases, run it in passive mode and quit
//! so the installer can replace the running executable.

use std::{
    fs::File,
    io::{copy, BufWriter},
    path::PathBuf,
    process::Command,
    time::Duration,
};

const ALLOWED_PREFIXES: &[&str] = &[
    "https://github.com/ASMAXI/",
    "https://objects.githubusercontent.com/",
    "https://release-assets.githubusercontent.com/",
];

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

fn download(url: &str, dest: &PathBuf) -> Result<(), String> {
    let response = ureq::get(url)
        .timeout(Duration::from_secs(600))
        .call()
        .map_err(|err| format!("Не удалось скачать обновление: {err}"))?;
    let file = File::create(dest).map_err(|err| err.to_string())?;
    let mut writer = BufWriter::new(file);
    copy(&mut response.into_reader(), &mut writer).map_err(|err| err.to_string())?;
    Ok(())
}

fn launch(dest: &PathBuf) -> Result<(), String> {
    let is_msi = dest
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("msi"));
    let result = if is_msi {
        Command::new("msiexec").arg("/i").arg(dest).arg("/passive").spawn()
    } else {
        // NSIS (Tauri template): /P = passive with progress bar, /R = relaunch after install.
        Command::new(dest).arg("/P").arg("/R").spawn()
    };
    result
        .map(|_| ())
        .map_err(|err| format!("Не удалось запустить установщик: {err}"))
}

/// Downloads the installer, starts it and exits the app.
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !ALLOWED_PREFIXES.iter().any(|prefix| url.starts_with(prefix)) {
        return Err("Обновления скачиваются только с GitHub Releases ASMAXI".into());
    }
    let dest = installer_path(&url)?;
    let target = dest.clone();
    tokio::task::spawn_blocking(move || download(&url, &target))
        .await
        .map_err(|err| err.to_string())??;
    launch(&dest)?;
    app.exit(0);
    Ok(())
}

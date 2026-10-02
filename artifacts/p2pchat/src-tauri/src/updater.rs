//! Self-update: download with progress, wait for install after exit, relaunch.
//!
//! Windows notes:
//! - Spawn the helper with CREATE_NO_WINDOW (no blank cmd flash).
//! - Wait until our exe unlocks, then `start /wait` the installer.
//! - NSIS `/D=` forces the same install dir as the running binary (avoids
//!   updating a different folder and relaunching the old 0.x.y build).

use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const DETACHED_PROCESS: u32 = 0x0000_0008;

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

/// NSIS `/D=` must be last and unquoted (even with spaces).
fn nsis_install_dir(app_exe: &Path) -> Option<String> {
    app_exe.parent().map(|dir| dir.to_string_lossy().replace('"', ""))
}

fn exe_image_name(app_exe: &Path) -> String {
    app_exe
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Drift.exe")
        .to_string()
}

/// After this process exits: run installer into the same folder, then relaunch.
fn spawn_deferred_install(installer: &Path, app_exe: &Path) -> Result<(), String> {
    let dir = std::env::temp_dir().join("drift-update");
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let script = dir.join("apply-update.cmd");
    let log = dir.join("apply-update.log");
    let is_msi = installer
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("msi"));
    let image = exe_image_name(app_exe);

    let install_line = if is_msi {
        // Quiet reinstall; TARGETDIR helps when previous install path is known.
        match nsis_install_dir(app_exe) {
            Some(target) => format!(
                "msiexec /i {} /qn /norestart REINSTALL=ALL REINSTALLMODE=vomus TARGETDIR={}",
                quote_cmd(installer),
                quote_cmd(Path::new(&target))
            ),
            None => format!(
                "msiexec /i {} /qn /norestart REINSTALL=ALL REINSTALLMODE=vomus",
                quote_cmd(installer)
            ),
        }
    } else {
        // Tauri NSIS silent upgrade into the folder of the running exe.
        match nsis_install_dir(app_exe) {
            Some(target) => format!("{} /S /D={}", quote_cmd(installer), target),
            None => format!("{} /S", quote_cmd(installer)),
        }
    };

    let contents = format!(
        "@echo off\r\n\
         setlocal EnableExtensions\r\n\
         set \"LOG={log}\"\r\n\
         echo Drift update helper started > \"%LOG%\"\r\n\
         echo installer={installer}>> \"%LOG%\"\r\n\
         echo app={app}>> \"%LOG%\"\r\n\
         rem Give the app time to exit and unlock files\r\n\
         ping 127.0.0.1 -n 5 >nul\r\n\
         set /a _tries=0\r\n\
         :wait_exit\r\n\
         set /a _tries+=1\r\n\
         tasklist /FI \"IMAGENAME eq {image}\" 2>nul | find /I \"{image}\" >nul\r\n\
         if not errorlevel 1 (\r\n\
           if %_tries% LSS 30 (\r\n\
             ping 127.0.0.1 -n 2 >nul\r\n\
             goto wait_exit\r\n\
           )\r\n\
         )\r\n\
         echo running installer>> \"%LOG%\"\r\n\
         {install_line}\r\n\
         set \"ERR=%ERRORLEVEL%\"\r\n\
         echo first_install_exit=%ERR%>> \"%LOG%\"\r\n\
         if not \"%ERR%\"==\"0\" (\r\n\
           ping 127.0.0.1 -n 3 >nul\r\n\
           {install_line}\r\n\
           set \"ERR=%ERRORLEVEL%\"\r\n\
           echo retry_install_exit=%ERR%>> \"%LOG%\"\r\n\
         )\r\n\
         ping 127.0.0.1 -n 3 >nul\r\n\
         if exist {app_q} (\r\n\
           echo relaunching>> \"%LOG%\"\r\n\
           start \"\" {app_q}\r\n\
         ) else (\r\n\
           echo missing_exe_after_install>> \"%LOG%\"\r\n\
         )\r\n\
         del \"%~f0\"\r\n",
        log = log.display(),
        installer = installer.display(),
        app = app_exe.display(),
        image = image,
        install_line = install_line,
        app_q = quote_cmd(app_exe),
    );
    std::fs::write(&script, contents).map_err(|err| err.to_string())?;

    // Run the .cmd itself with no console — do NOT nest `start` (that flashes CMD).
    let mut cmd = Command::new("cmd.exe");
    cmd.args(["/C", &script.to_string_lossy()]);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    cmd.spawn()
        .map_err(|err| format!("Не удалось запланировать установку: {err}"))?;
    Ok(())
}

fn launch_and_exit(app: &AppHandle, dest: &PathBuf) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|err| err.to_string())?;
    emit_progress(app, 0, None, "install");
    spawn_deferred_install(dest, &exe)?;
    emit_progress(app, 1, Some(1), "done");
    // Let the detached helper start before we unlock our binary.
    std::thread::sleep(Duration::from_millis(600));
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

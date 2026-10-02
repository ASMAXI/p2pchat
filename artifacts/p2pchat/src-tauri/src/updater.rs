//! Self-update: download with progress, wait for install after exit, relaunch.
//!
//! Uses a hidden PowerShell helper (no ping/find CMD windows).
//! Waits for our PID to exit, runs the installer silently into the same
//! folder, then relaunches Drift.exe / p2pchat.exe.

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
    if loaded < 500_000 {
        let _ = std::fs::remove_file(dest);
        return Err(format!(
            "Файл обновления слишком маленький ({loaded} байт) — вероятно ошибка скачивания"
        ));
    }
    Ok(())
}

fn ps_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn install_powershell_snippet(is_msi: bool) -> &'static str {
    if is_msi {
        r#"
$msiArgs = "/i `"$installer`" /qn /norestart REINSTALL=ALL REINSTALLMODE=vomus"
if ($installDir) { $msiArgs = "$msiArgs TARGETDIR=`"$installDir`"" }
$p = Start-Process -FilePath "msiexec.exe" -ArgumentList $msiArgs -Wait -PassThru -WindowStyle Hidden
"#
    } else {
        r#"
$nsisArgs = "/S"
if ($installDir) { $nsisArgs = "/S /D=$installDir" }
$p = Start-Process -FilePath $installer -ArgumentList $nsisArgs -Wait -PassThru -WindowStyle Hidden
"#
    }
}

/// After this process exits: silent install into the same folder, then relaunch.
fn spawn_deferred_install(installer: &Path, app_exe: &Path) -> Result<(), String> {
    let dir = std::env::temp_dir().join("drift-update");
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let script = dir.join("apply-update.ps1");
    let log = dir.join("apply-update.log");
    let pid = std::process::id();
    let install_dir = app_exe
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let is_msi = installer
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("msi"));
    let install_snippet = install_powershell_snippet(is_msi);

    let contents = format!(
        r#"
$ErrorActionPreference = "Continue"
$log = {log}
$appExe = {app}
$installDir = {dir}
$installer = {installer}
$pidToWait = {pid}
"Drift update helper $(Get-Date -Format o)" | Out-File -FilePath $log -Encoding utf8
"pid=$pidToWait installer=$installer app=$appExe dir=$installDir" | Add-Content $log

try {{
  Wait-Process -Id $pidToWait -Timeout 180 -ErrorAction SilentlyContinue
}} catch {{}}
Start-Sleep -Seconds 2

for ($i = 0; $i -lt 60; $i++) {{
  try {{
    if (Test-Path $appExe) {{
      $fs = [System.IO.File]::Open($appExe, "Open", "ReadWrite", "None")
      $fs.Close()
      break
    }} else {{
      break
    }}
  }} catch {{
    Start-Sleep -Milliseconds 500
  }}
}}
"file unlocked (or missing), running installer" | Add-Content $log

$p = $null
{install_snippet}
$code = if ($p) {{ $p.ExitCode }} else {{ -1 }}
"installer_exit=$code" | Add-Content $log

if ($code -ne 0) {{
  Start-Sleep -Seconds 2
  $p = $null
  {install_snippet}
  $code = if ($p) {{ $p.ExitCode }} else {{ -1 }}
  "installer_retry_exit=$code" | Add-Content $log
}}

Start-Sleep -Seconds 2

$candidates = @(
  $appExe,
  (Join-Path $installDir "Drift.exe"),
  (Join-Path $installDir "p2pchat.exe"),
  (Join-Path $env:LOCALAPPDATA "Drift\Drift.exe"),
  (Join-Path $env:LOCALAPPDATA "p2pchat\p2pchat.exe")
) | Select-Object -Unique

$launched = $false
foreach ($c in $candidates) {{
  if ($c -and (Test-Path $c)) {{
    try {{
      Start-Process -FilePath $c
      "relaunch $c" | Add-Content $log
      $launched = $true
      break
    }} catch {{
      "relaunch_fail $c $_" | Add-Content $log
    }}
  }}
}}
if (-not $launched) {{ "no_exe_to_relaunch" | Add-Content $log }}

Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
"#,
        log = ps_single_quote(&log.to_string_lossy()),
        app = ps_single_quote(&app_exe.to_string_lossy()),
        dir = ps_single_quote(&install_dir),
        installer = ps_single_quote(&installer.to_string_lossy()),
        pid = pid,
        install_snippet = install_snippet,
    );

    std::fs::write(&script, contents).map_err(|err| err.to_string())?;

    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
        &script.to_string_lossy(),
    ]);
    #[cfg(windows)]
    {
        // Hidden only — DETACHED_PROCESS often creates visible consoles for child tools.
        cmd.creation_flags(CREATE_NO_WINDOW);
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
    std::thread::sleep(Duration::from_millis(700));
    app.exit(0);
    Ok(())
}

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

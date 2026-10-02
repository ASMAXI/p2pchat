//! Self-update: download with progress, wait for install after exit, relaunch.
//!
//! Hidden PowerShell helper (no ping/find CMD windows).
//! Crucially: only relaunches AFTER a successful install, into the same folder,
//! and prefers the newest Drift.exe so an old copy is not started by mistake.

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

/// After this process exits: silent install into the same folder, then relaunch ONLY on success.
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

    // Capture pre-install file time so we can detect a real overwrite.
    let contents = format!(
        r#"
$ErrorActionPreference = "Continue"
$log = {log}
$appExe = {app}
$installDir = {dir}
$installer = {installer}
$pidToWait = {pid}
$isMsi = {is_msi}
"Drift update helper $(Get-Date -Format o)" | Out-File -FilePath $log -Encoding utf8
"pid=$pidToWait installer=$installer app=$appExe dir=$installDir msi=$isMsi" | Add-Content $log

function Log($msg) {{ "$msg" | Add-Content $log }}

try {{ Wait-Process -Id $pidToWait -Timeout 180 -ErrorAction SilentlyContinue }} catch {{}}
Start-Sleep -Seconds 2

# Make sure no leftover Drift / overlay / cloudflared holds the EXE lock.
Get-Process -Name "Drift","p2pchat","cloudflared","ngrok" -ErrorAction SilentlyContinue |
  Where-Object {{ $_.Id -ne $pidToWait }} |
  ForEach-Object {{
    try {{ Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue; Log "killed $($_.ProcessName) $($_.Id)" }} catch {{}}
  }}
Start-Sleep -Seconds 1

for ($i = 0; $i -lt 90; $i++) {{
  try {{
    if (Test-Path $appExe) {{
      $fs = [System.IO.File]::Open($appExe, "Open", "ReadWrite", "None")
      $fs.Close()
      break
    }} else {{ break }}
  }} catch {{
    Start-Sleep -Milliseconds 500
  }}
}}
Log "file unlocked (or missing), running installer"

$beforeTime = $null
if (Test-Path $appExe) {{
  $beforeTime = (Get-Item -LiteralPath $appExe).LastWriteTimeUtc
  Log "before_mtime=$beforeTime"
}}

function Run-Installer {{
  if ($isMsi) {{
    $msiArgs = @("/i", $installer, "/qn", "/norestart", "REINSTALL=ALL", "REINSTALLMODE=vomus")
    if ($installDir) {{ $msiArgs += "TARGETDIR=$installDir" }}
    $p = Start-Process -FilePath "msiexec.exe" -ArgumentList $msiArgs -Wait -PassThru -WindowStyle Hidden
    return $p
  }}
  # NSIS: /D= MUST be last and the path must NOT be quoted (even with spaces).
  # Use ProcessStartInfo so PowerShell does not split the path on spaces.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $installer
  if ($installDir) {{
    $psi.Arguments = "/S /D=$installDir"
  }} else {{
    $psi.Arguments = "/S"
  }}
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  Log "nsis_args=$($psi.Arguments)"
  $p = [System.Diagnostics.Process]::Start($psi)
  if (-not $p) {{ return $null }}
  $p.WaitForExit()
  return $p
}}

$p = Run-Installer
$code = if ($p) {{ $p.ExitCode }} else {{ -1 }}
Log "installer_exit=$code"

if ($code -ne 0) {{
  Start-Sleep -Seconds 2
  $p = Run-Installer
  $code = if ($p) {{ $p.ExitCode }} else {{ -1 }}
  Log "installer_retry_exit=$code"
}}

if ($code -ne 0) {{
  Log "INSTALL_FAILED — not relaunching (keep old binary untouched in UI terms)"
  exit 1
}}

Start-Sleep -Seconds 2

$candidates = @(
  (Join-Path $installDir "Drift.exe"),
  (Join-Path $installDir "p2pchat.exe"),
  $appExe,
  (Join-Path $env:LOCALAPPDATA "Drift\Drift.exe"),
  (Join-Path $env:LOCALAPPDATA "p2pchat\p2pchat.exe")
) | Where-Object {{ $_ -and (Test-Path $_) }} | Select-Object -Unique

# Prefer the newest file (freshly written by the installer).
$best = $candidates |
  ForEach-Object {{ Get-Item -LiteralPath $_ }} |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1

if (-not $best) {{
  Log "no_exe_to_relaunch"
  exit 1
}}

if ($beforeTime -and $best.LastWriteTimeUtc -le $beforeTime) {{
  Log "WARN exe_mtime_not_newer before=$beforeTime after=$($best.LastWriteTimeUtc) path=$($best.FullName)"
  # Still try default install locations in case /D= was ignored.
  $fallback = @(
    (Join-Path $env:LOCALAPPDATA "Drift\Drift.exe"),
    (Join-Path $env:LOCALAPPDATA "p2pchat\Drift.exe")
  ) | Where-Object {{ Test-Path $_ }} |
    ForEach-Object {{ Get-Item -LiteralPath $_ }} |
    Where-Object {{ $_.LastWriteTimeUtc -gt $beforeTime }} |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
  if ($fallback) {{
    $best = $fallback
    Log "using_newer_fallback $($best.FullName)"
  }} else {{
    Log "INSTALL_MAY_HAVE_FAILED_SILENTLY — relaunching anyway but version may be old"
  }}
}}

$ver = $best.VersionInfo.ProductVersion
if (-not $ver) {{ $ver = $best.VersionInfo.FileVersion }}
Log "relaunch $($best.FullName) version=$ver mtime=$($best.LastWriteTimeUtc)"

try {{
  Start-Process -FilePath $best.FullName
}} catch {{
  Log "relaunch_fail $_"
  exit 1
}}

Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
"#,
        log = ps_single_quote(&log.to_string_lossy()),
        app = ps_single_quote(&app_exe.to_string_lossy()),
        dir = ps_single_quote(&install_dir),
        installer = ps_single_quote(&installer.to_string_lossy()),
        pid = pid,
        is_msi = if is_msi { "$true" } else { "$false" },
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

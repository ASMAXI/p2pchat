//! Self-update: download, then an elevated NSIS install (`/P /UPDATE /R`).
//!
//! The installer is per-machine (`C:\Program Files\Drift`). It must be started
//! via ShellExecute so UAC can write that folder. `/S` without elevation left
//! the desktop shortcut on the old `p2pchat.exe`.

use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use serde::Serialize;
use sha2::{Digest, Sha256};
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

fn file_sha256_hex(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|err| err.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|err| err.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn normalize_sha256(value: &str) -> Option<String> {
    let trimmed = value
        .trim()
        .trim_start_matches("sha256:")
        .trim_start_matches("SHA256:")
        .trim();
    if trimmed.len() == 64 && trimmed.chars().all(|ch| ch.is_ascii_hexdigit()) {
        Some(trimmed.to_ascii_lowercase())
    } else {
        None
    }
}

fn verify_installer_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let expected = normalize_sha256(expected)
        .ok_or_else(|| "Некорректный SHA-256 установщика из релиза".to_string())?;
    let actual = file_sha256_hex(path)?;
    if actual == expected {
        return Ok(());
    }
    Err(format!(
        "Проверка обновления не прошла (ожидался SHA-256 {expected}, получен {actual})"
    ))
}

fn ps_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// After this process exits: elevated NSIS `/P /UPDATE /R` into Program Files, then the installer relaunches.
///
/// Previous builds used `/S` without elevation (`UseShellExecute=false`), so a current-user
/// installer could not overwrite `C:\Program Files\Drift\p2pchat.exe` and the desktop shortcut
/// kept starting the old binary.
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

function Relaunch-Old {{
  if ($appExe -and (Test-Path -LiteralPath $appExe)) {{
    Log "relaunch_old $appExe"
    Start-Process -FilePath $appExe
  }}
}}

try {{ Wait-Process -Id $pidToWait -Timeout 180 -ErrorAction SilentlyContinue }} catch {{}}
Start-Sleep -Seconds 2

Get-Process -Name "Drift","p2pchat","cloudflared","ngrok" -ErrorAction SilentlyContinue |
  Where-Object {{ $_.Id -ne $PID }} |
  ForEach-Object {{
    try {{ Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue; Log "killed $($_.ProcessName) $($_.Id)" }} catch {{}}
  }}
Start-Sleep -Seconds 1

for ($i = 0; $i -lt 90; $i++) {{
  try {{
    if (Test-Path -LiteralPath $appExe) {{
      $fs = [System.IO.File]::Open($appExe, "Open", "ReadWrite", "None")
      $fs.Close()
      break
    }} else {{ break }}
  }} catch {{
    Start-Sleep -Milliseconds 500
  }}
}}
Log "file unlocked, running installer (UAC)"

$beforeVer = $null
if (Test-Path -LiteralPath $appExe) {{
  $beforeVer = (Get-Item -LiteralPath $appExe).VersionInfo.ProductVersion
  Log "before_version=$beforeVer"
}}

# ShellExecute (default) so RequestExecutionLevel admin can show UAC.
# /P = passive UI, /UPDATE = in-place upgrade, /R = installer starts the new exe.
# /D= MUST be last and unquoted — installs into the folder of the running exe
# (Program Files, custom path, etc.), not a hard-coded default.
try {{
  if ($isMsi) {{
    $msiArgs = @("/i", $installer, "/passive", "/norestart")
    if ($installDir) {{ $msiArgs += "TARGETDIR=$installDir" }}
    Log "msi_args=$($msiArgs -join ' ')"
    $p = Start-Process -FilePath "msiexec.exe" -ArgumentList $msiArgs -Wait -PassThru
  }} else {{
    # Build one argument string so /D=path with spaces stays intact for NSIS.
    $nsisArgs = "/P /UPDATE /R"
    if ($installDir) {{ $nsisArgs = "/P /UPDATE /R /D=$installDir" }}
    Log "nsis_args=$nsisArgs"
    $p = Start-Process -FilePath $installer -ArgumentList $nsisArgs -Wait -PassThru
  }}
  $code = if ($p) {{ $p.ExitCode }} else {{ -1 }}
  Log "installer_exit=$code"
}} catch {{
  Log "installer_start_fail $_"
  Relaunch-Old
  exit 1
}}

if ($code -ne 0) {{
  Log "INSTALL_FAILED code=$code"
  Relaunch-Old
  exit 1
}}

Start-Sleep -Seconds 2
$target = Join-Path $installDir "p2pchat.exe"
if (-not (Test-Path -LiteralPath $target)) {{ $target = $appExe }}
$afterVer = $null
if (Test-Path -LiteralPath $target) {{
  $afterVer = (Get-Item -LiteralPath $target).VersionInfo.ProductVersion
}}
Log "after_version=$afterVer path=$target"

$running = Get-Process -Name "p2pchat","Drift" -ErrorAction SilentlyContinue
if (-not $running) {{
  if ($target -and (Test-Path -LiteralPath $target)) {{
    Log "installer did not relaunch, starting $target"
    Start-Process -FilePath $target
  }} else {{
    Relaunch-Old
  }}
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
pub async fn install_update(
    app: AppHandle,
    url: String,
    sha256: Option<String>,
) -> Result<(), String> {
    if !ALLOWED_PREFIXES.iter().any(|prefix| url.starts_with(prefix)) {
        return Err("Обновления скачиваются только с GitHub Releases ASMAXI".into());
    }
    let expected = sha256
        .as_deref()
        .and_then(normalize_sha256)
        .ok_or_else(|| {
            "В релизе нет SHA-256 установщика — обновление через приложение недоступно. Скачайте вручную со страницы релиза."
                .to_string()
        })?;
    let dest = installer_path(&url)?;
    let target = dest.clone();
    let app_dl = app.clone();
    tokio::task::spawn_blocking(move || download(&url, &target, &app_dl))
        .await
        .map_err(|err| err.to_string())??;
    emit_progress(&app, 0, None, "verify");
    if let Err(err) = verify_installer_sha256(&dest, &expected) {
        let _ = std::fs::remove_file(&dest);
        return Err(err);
    }
    launch_and_exit(&app, &dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_github_digest() {
        assert_eq!(
            normalize_sha256("sha256:95572fc81114a806eebf5c189e5e94ed36311b1a5bb273dfb30eebbba2e98cad"),
            Some("95572fc81114a806eebf5c189e5e94ed36311b1a5bb273dfb30eebbba2e98cad".into())
        );
        assert_eq!(normalize_sha256("not-a-hash"), None);
    }
}

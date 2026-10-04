//! Public tunnels for the control plane (chat + signaling).
//! Providers: Cloudflare, ngrok, localhost.run, Pinggy, Bore, zrok.

use std::{
    fs::File,
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TunnelProvider {
    #[default]
    Cloudflare,
    Ngrok,
    #[serde(rename = "localhostRun", alias = "localhost")]
    LocalhostRun,
    Pinggy,
    Bore,
    Zrok,
}

impl TunnelProvider {
    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "ngrok" => Self::Ngrok,
            "localhost" | "localhostrun" | "localhost_run" | "localhost.run" => Self::LocalhostRun,
            "pinggy" => Self::Pinggy,
            "bore" => Self::Bore,
            "zrok" => Self::Zrok,
            _ => Self::Cloudflare,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cloudflare => "cloudflare",
            Self::Ngrok => "ngrok",
            Self::LocalhostRun => "localhostRun",
            Self::Pinggy => "pinggy",
            Self::Bore => "bore",
            Self::Zrok => "zrok",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    pub public_origin: String,
    pub provider: &'static str,
}

pub struct TunnelHandle {
    child: Arc<Mutex<Option<Child>>>,
}

impl Drop for TunnelHandle {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn prefs_path(app_data: &Path) -> PathBuf {
    app_data.join("tunnel-prefs.json")
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TunnelPrefs {
    provider: String,
    #[serde(default)]
    ngrok_auth_token: String,
    #[serde(default)]
    zrok_token: String,
}

pub fn save_tunnel_prefs(
    app_data: &Path,
    provider: TunnelProvider,
    ngrok_auth_token: &str,
    zrok_token: &str,
) {
    let _ = std::fs::create_dir_all(app_data);
    let prefs = TunnelPrefs {
        provider: provider.as_str().to_string(),
        ngrok_auth_token: ngrok_auth_token.to_string(),
        zrok_token: zrok_token.to_string(),
    };
    if let Ok(raw) = serde_json::to_string_pretty(&prefs) {
        let _ = std::fs::write(prefs_path(app_data), raw);
    }
}

pub fn load_tunnel_prefs(app_data: &Path) -> (TunnelProvider, String, String) {
    let raw = std::fs::read_to_string(prefs_path(app_data)).unwrap_or_default();
    let prefs: TunnelPrefs = serde_json::from_str(&raw).unwrap_or_default();
    (
        TunnelProvider::parse(&prefs.provider),
        prefs.ngrok_auth_token,
        prefs.zrok_token,
    )
}

fn hide_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

fn extract_url_line(line: &str, host_hints: &[String]) -> Option<String> {
    for scheme in ["https://", "http://"] {
        if let Some(start) = line.find(scheme) {
            let rest = &line[start..];
            let end = rest
                .find(|c: char| c.is_whitespace() || c == '|' || c == '"' || c == '\'' || c == ']')
                .unwrap_or(rest.len());
            let candidate = rest[..end].trim_end_matches(['.', ',', ';', ')', ']']);
            if host_hints.iter().any(|hint| candidate.contains(hint.as_str())) {
                return Some(candidate.trim_end_matches('/').to_string());
            }
        }
    }
    // bore.pub:12345 → http://bore.pub:12345
    if host_hints.iter().any(|h| h.contains("bore.pub")) {
        if let Some(idx) = line.find("bore.pub:") {
            let after = &line[idx + "bore.pub:".len()..];
            let port: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
            if !port.is_empty() {
                return Some(format!("http://bore.pub:{port}"));
            }
        }
    }
    None
}

fn wait_for_url_from_child(
    child: &mut Child,
    host_hints: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "tunnel stderr unavailable".to_string())?;
    let stdout = child.stdout.take();
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let hints: Vec<String> = host_hints.iter().map(|s| (*s).to_string()).collect();
    let hints2 = hints.clone();
    let label = host_hints.first().copied().unwrap_or("tunnel");
    let tx2 = tx.clone();

    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            if let Some(url) = extract_url_line(&line, &hints) {
                let _ = tx.send(Ok(url));
            }
        }
    });

    if let Some(stdout) = stdout {
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                if let Some(url) = extract_url_line(&line, &hints2) {
                    let _ = tx2.send(Ok(url));
                }
            }
        });
    }

    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Таймаут: туннель ({label}) не выдал публичный URL"));
        }
        match rx.recv_timeout(remaining) {
            Ok(Ok(url)) => return Ok(url),
            Ok(Err(err)) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(err);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Таймаут: туннель ({label}) не выдал публичный URL"));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Процесс туннеля завершился до выдачи URL".into());
            }
        }
    }
}

fn wrap_handle(child: Child, public: String, provider: TunnelProvider) -> (TunnelHandle, TunnelInfo) {
    (
        TunnelHandle {
            child: Arc::new(Mutex::new(Some(child))),
        },
        TunnelInfo {
            public_origin: public,
            provider: provider.as_str(),
        },
    )
}

// --- Cloudflare -----------------------------------------------------------

/// Pinned cloudflared release (avoid floating `latest` binary).
const CLOUDFLARED_VERSION: &str = "2025.2.0";

/// Official SHA-256 from the Cloudflare GitHub release notes for 2025.2.0.
fn cloudflared_expected_sha256() -> Option<&'static str> {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Some("74eb23de1b2fdc7862447dddaadaa82fd5b43659b3c41205a40ea194dff373a9")
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some("cbd18c5a6dee084db7a55d761b91202e47e63ddbd18d0faff04ca96e56739b3f")
    } else {
        None
    }
}

fn cloudflared_exe_name() -> &'static str {
    if cfg!(windows) {
        "cloudflared.exe"
    } else {
        "cloudflared"
    }
}

fn cloudflared_download_url() -> String {
    let file = if cfg!(target_os = "windows") {
        "cloudflared-windows-amd64.exe"
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "cloudflared-darwin-arm64.tgz"
        } else {
            "cloudflared-darwin-amd64.tgz"
        }
    } else {
        "cloudflared-linux-amd64"
    };
    format!(
        "https://github.com/cloudflare/cloudflared/releases/download/{CLOUDFLARED_VERSION}/{file}"
    )
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

fn verify_cloudflared_sha256(path: &Path) -> Result<(), String> {
    let Some(expected) = cloudflared_expected_sha256() else {
        return Ok(());
    };
    let actual = file_sha256_hex(path)?;
    if actual.eq_ignore_ascii_case(expected) {
        return Ok(());
    }
    Err(format!(
        "Проверка cloudflared не прошла (ожидался SHA-256 {expected}, получен {actual})"
    ))
}

fn ensure_cloudflared(bin_dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(bin_dir).map_err(|err| err.to_string())?;
    let dest = bin_dir.join(cloudflared_exe_name());
    let marker = bin_dir.join("cloudflared.version");
    let pinned = std::fs::read_to_string(&marker)
        .map(|value| value.trim() == CLOUDFLARED_VERSION)
        .unwrap_or(false);
    if dest.exists() && pinned && verify_cloudflared_sha256(&dest).is_ok() {
        return Ok(dest);
    }
    let url = cloudflared_download_url();
    if url.ends_with(".tgz") {
        return Err(
            "На macOS положите cloudflared в каталог приложения или установите через brew".into(),
        );
    }
    if dest.exists() {
        let _ = std::fs::remove_file(&dest);
    }
    download_file(&url, &dest)?;
    if let Err(err) = verify_cloudflared_sha256(&dest) {
        let _ = std::fs::remove_file(&dest);
        let _ = std::fs::remove_file(&marker);
        return Err(err);
    }
    #[cfg(unix)]
    set_executable(&dest)?;
    std::fs::write(&marker, CLOUDFLARED_VERSION).map_err(|err| err.to_string())?;
    Ok(dest)
}

fn start_cloudflare(app_data: &Path, local_port: u16) -> Result<(TunnelHandle, TunnelInfo), String> {
    let bin = ensure_cloudflared(&app_data.join("bin"))?;
    let target = format!("http://127.0.0.1:{local_port}");
    let mut command = Command::new(&bin);
    command
        .arg("tunnel")
        .arg("--url")
        .arg(&target)
        .arg("--no-autoupdate")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|err| format!("Не удалось запустить cloudflared: {err}"))?;
    let public = wait_for_url_from_child(&mut child, &["trycloudflare.com"], Duration::from_secs(45))?;
    Ok(wrap_handle(child, public, TunnelProvider::Cloudflare))
}

// --- ngrok ----------------------------------------------------------------

fn ngrok_exe_name() -> &'static str {
    if cfg!(windows) {
        "ngrok.exe"
    } else {
        "ngrok"
    }
}

fn ngrok_zip_url() -> Option<&'static str> {
    if cfg!(target_os = "windows") {
        Some("https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip")
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some("https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz")
    } else {
        None
    }
}

fn ensure_ngrok(bin_dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(bin_dir).map_err(|err| err.to_string())?;
    let dest = bin_dir.join(ngrok_exe_name());
    if dest.exists() {
        return Ok(dest);
    }
    // Prefer PATH-installed ngrok.
    if let Ok(path) = which_ngrok() {
        return Ok(path);
    }
    let Some(url) = ngrok_zip_url() else {
        return Err(
            "Скачайте ngrok вручную и положите в PATH, либо используйте Cloudflare / localhost.run"
                .into(),
        );
    };
    if url.ends_with(".tgz") {
        return Err("На этой ОС установите ngrok вручную (https://ngrok.com/download)".into());
    }
    let zip_path = bin_dir.join("ngrok.zip");
    download_file(url, &zip_path)?;
    extract_zip_windows(&zip_path, bin_dir)?;
    let _ = std::fs::remove_file(&zip_path);
    if !dest.exists() {
        return Err("Архив ngrok скачан, но ngrok.exe не найден после распаковки".into());
    }
    Ok(dest)
}

fn which_ngrok() -> Result<PathBuf, ()> {
    let mut cmd = Command::new(if cfg!(windows) { "where" } else { "which" });
    cmd.arg("ngrok");
    hide_window(&mut cmd);
    let output = cmd.output().map_err(|_| ())?;
    if !output.status.success() {
        return Err(());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        return Err(());
    }
    Ok(PathBuf::from(line))
}

fn extract_zip_windows(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        let status = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Expand-Archive -LiteralPath {} -DestinationPath {} -Force",
                    ps_quote(&zip_path.to_string_lossy()),
                    ps_quote(&dest_dir.to_string_lossy())
                ),
            ])
            .status()
            .map_err(|err| format!("Expand-Archive: {err}"))?;
        if !status.success() {
            return Err("Не удалось распаковать ngrok.zip".into());
        }
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        let _ = (zip_path, dest_dir);
        Err("Распаковка zip на этой ОС не реализована".into())
    }
}

fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn poll_ngrok_api(timeout: Duration) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    let mut last_err = "ngrok API ещё не ответил".to_string();
    while Instant::now() < deadline {
        match fetch_ngrok_public_url() {
            Ok(url) => return Ok(url),
            Err(err) => last_err = err,
        }
        thread::sleep(Duration::from_millis(400));
    }
    Err(format!("Таймаут ngrok: {last_err}"))
}

fn fetch_ngrok_public_url() -> Result<String, String> {
    let mut stream = TcpStream::connect_timeout(
        &"127.0.0.1:4040".parse().unwrap(),
        Duration::from_secs(1),
    )
    .map_err(|err| format!("API 4040: {err}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .ok();
    stream
        .write_all(b"GET /api/tunnels HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .map_err(|err| err.to_string())?;
    let mut body = String::new();
    stream.read_to_string(&mut body).map_err(|err| err.to_string())?;
    let json_start = body.find('{').ok_or_else(|| "пустой ответ ngrok API".to_string())?;
    let json = &body[json_start..];
    // Prefer public_url https
    if let Some(url) = json
        .split("\"public_url\"")
        .skip(1)
        .filter_map(|chunk| {
            let start = chunk.find('"')? + 1;
            let rest = &chunk[start..];
            let end = rest.find('"')?;
            Some(rest[..end].to_string())
        })
        .find(|u| u.starts_with("https://"))
    {
        return Ok(url.trim_end_matches('/').to_string());
    }
    Err("В ответе ngrok нет https public_url (проверьте authtoken)".into())
}

fn start_ngrok(
    app_data: &Path,
    local_port: u16,
    auth_token: &str,
) -> Result<(TunnelHandle, TunnelInfo), String> {
    let token = auth_token.trim();
    if token.is_empty() {
        return Err(
            "Для ngrok нужен authtoken: зарегистрируйтесь на ngrok.com → Your Authtoken → вставьте в настройки Drift"
                .into(),
        );
    }
    let bin = ensure_ngrok(&app_data.join("bin"))?;
    let mut command = Command::new(&bin);
    command
        .arg("http")
        .arg(local_port.to_string())
        .arg("--authtoken")
        .arg(token)
        .arg("--log")
        .arg("stdout")
        .arg("--log-format")
        .arg("logfmt")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|err| format!("Не удалось запустить ngrok: {err}"))?;

    // Prefer local API; also accept URL from logs as backup.
    let api_result = poll_ngrok_api(Duration::from_secs(40));
    let public = match api_result {
        Ok(url) => url,
        Err(api_err) => match wait_for_url_from_child(&mut child, &["ngrok"], Duration::from_secs(10))
        {
            Ok(url) => url,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(api_err);
            }
        },
    };
    Ok(wrap_handle(child, public, TunnelProvider::Ngrok))
}

// --- localhost.run --------------------------------------------------------

fn find_ssh() -> Result<PathBuf, String> {
    let candidates = if cfg!(windows) {
        vec![
            PathBuf::from(r"C:\Windows\System32\OpenSSH\ssh.exe"),
            PathBuf::from("ssh.exe"),
            PathBuf::from("ssh"),
        ]
    } else {
        vec![PathBuf::from("ssh")]
    };
    for candidate in candidates {
        let mut cmd = Command::new(&candidate);
        cmd.arg("-V");
        hide_window(&mut cmd);
        if cmd.stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok() {
            return Ok(candidate);
        }
    }
    Err(
        "Не найден OpenSSH (ssh). Установите «OpenSSH Client» в Параметры Windows → Приложения → Доп. компоненты, либо выберите Cloudflare / ngrok / Bore"
            .into(),
    )
}

fn ssh_base_command(ssh: &Path, local_port: u16) -> Command {
    let known_hosts = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let mut command = Command::new(ssh);
    command
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg(format!("UserKnownHostsFile={known_hosts}"))
        .arg("-o")
        .arg("ServerAliveInterval=30")
        .arg("-o")
        .arg("ExitOnForwardFailure=yes")
        .arg("-o")
        .arg("NumberOfPasswordPrompts=0")
        .arg("-T")
        .arg("-R")
        .arg(format!("0:127.0.0.1:{local_port}"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut command);
    command
}

fn start_localhost_run(local_port: u16) -> Result<(TunnelHandle, TunnelInfo), String> {
    let ssh = find_ssh()?;
    let known_hosts = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let mut command = Command::new(&ssh);
    command
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg(format!("UserKnownHostsFile={known_hosts}"))
        .arg("-o")
        .arg("ServerAliveInterval=30")
        .arg("-o")
        .arg("ExitOnForwardFailure=yes")
        .arg("-T")
        .arg("-R")
        .arg(format!("80:127.0.0.1:{local_port}"))
        .arg("nokey@localhost.run")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|err| format!("Не удалось запустить ssh (localhost.run): {err}"))?;
    let public =
        wait_for_url_from_child(&mut child, &["localhost.run"], Duration::from_secs(50))?;
    Ok(wrap_handle(child, public, TunnelProvider::LocalhostRun))
}

fn start_pinggy(local_port: u16) -> Result<(TunnelHandle, TunnelInfo), String> {
    let ssh = find_ssh()?;
    let mut command = ssh_base_command(&ssh, local_port);
    command.arg("-p").arg("443").arg("free.pinggy.io");
    let mut child = command
        .spawn()
        .map_err(|err| format!("Не удалось запустить ssh (Pinggy): {err}"))?;
    let public = wait_for_url_from_child(
        &mut child,
        &["pinggy", "pinggy.io", "pinggy-free.link", "a.free.pinggy.io"],
        Duration::from_secs(55),
    )?;
    Ok(wrap_handle(child, public, TunnelProvider::Pinggy))
}

// --- Bore -----------------------------------------------------------------

fn ensure_bore(bin_dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(bin_dir).map_err(|err| err.to_string())?;
    let dest = bin_dir.join(if cfg!(windows) { "bore.exe" } else { "bore" });
    if dest.exists() {
        return Ok(dest);
    }
    let url = github_release_asset_url("ekzhang/bore", &["windows", "msvc", ".zip"])
        .or_else(|_| github_release_asset_url("ekzhang/bore", &["windows", ".zip"]))?;
    let zip_path = bin_dir.join("bore.zip");
    download_file(&url, &zip_path)?;
    extract_zip_windows(&zip_path, bin_dir)?;
    let _ = std::fs::remove_file(&zip_path);
    // GitHub zips often nest the binary in a folder — search.
    if !dest.exists() {
        if let Some(found) = find_file_named(bin_dir, "bore.exe").or_else(|| find_file_named(bin_dir, "bore")) {
            let _ = std::fs::copy(&found, &dest);
        }
    }
    if !dest.exists() {
        return Err("bore скачан, но бинарник не найден после распаковки".into());
    }
    #[cfg(unix)]
    set_executable(&dest)?;
    Ok(dest)
}

fn start_bore(app_data: &Path, local_port: u16) -> Result<(TunnelHandle, TunnelInfo), String> {
    let bin = ensure_bore(&app_data.join("bin"))?;
    let mut command = Command::new(&bin);
    command
        .arg("local")
        .arg(local_port.to_string())
        .arg("--to")
        .arg("bore.pub")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|err| format!("Не удалось запустить bore: {err}"))?;
    let public = wait_for_url_from_child(&mut child, &["bore.pub"], Duration::from_secs(40))?;
    Ok(wrap_handle(child, public, TunnelProvider::Bore))
}

// --- zrok -----------------------------------------------------------------

fn ensure_zrok(bin_dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(bin_dir).map_err(|err| err.to_string())?;
    let dest = bin_dir.join(if cfg!(windows) { "zrok.exe" } else { "zrok" });
    if dest.exists() {
        return Ok(dest);
    }
    let url = github_release_asset_url("openziti/zrok", &["windows", "amd64"])
        .or_else(|_| github_release_asset_url("openziti/zrok", &["windows"]))?;
    let archive = if url.contains(".zip") {
        bin_dir.join("zrok.zip")
    } else {
        bin_dir.join("zrok.tgz")
    };
    download_file(&url, &archive)?;
    if url.contains(".zip") {
        extract_zip_windows(&archive, bin_dir)?;
    } else {
        extract_tar_gz(&archive, bin_dir)?;
    }
    let _ = std::fs::remove_file(&archive);
    if !dest.exists() {
        if let Some(found) =
            find_file_named(bin_dir, "zrok.exe").or_else(|| find_file_named(bin_dir, "zrok"))
        {
            let _ = std::fs::copy(&found, &dest);
        }
    }
    if !dest.exists() {
        return Err("zrok скачан, но бинарник не найден".into());
    }
    #[cfg(unix)]
    set_executable(&dest)?;
    Ok(dest)
}

fn extract_tar_gz(archive: &Path, dest_dir: &Path) -> Result<(), String> {
    let mut cmd = Command::new("tar");
    cmd.args([
        "-xf",
        &archive.to_string_lossy(),
        "-C",
        &dest_dir.to_string_lossy(),
    ]);
    hide_window(&mut cmd);
    let status = cmd
        .status()
        .map_err(|err| format!("tar: {err}. Установите zrok вручную с GitHub Releases."))?;
    if !status.success() {
        return Err("Не удалось распаковать zrok (tar)".into());
    }
    Ok(())
}

fn ensure_zrok_enabled(bin: &Path, token: &str) -> Result<(), String> {
    let mut command = Command::new(bin);
    command
        .arg("enable")
        .arg(token)
        .arg("--headless")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut command);
    let output = command
        .output()
        .map_err(|err| format!("zrok enable: {err}"))?;
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if output.status.success()
        || combined.to_ascii_lowercase().contains("already enabled")
        || combined.to_ascii_lowercase().contains("enabled")
    {
        return Ok(());
    }
    Err(format!(
        "zrok enable не удался. Проверьте токен с zrok.io. {}",
        combined.chars().take(240).collect::<String>()
    ))
}

fn start_zrok(
    app_data: &Path,
    local_port: u16,
    token: &str,
) -> Result<(TunnelHandle, TunnelInfo), String> {
    let token = token.trim();
    if token.is_empty() {
        return Err(
            "Для zrok нужен account token: zrok.io → Enable Your Environment → вставьте в настройки Drift"
                .into(),
        );
    }
    let bin = ensure_zrok(&app_data.join("bin"))?;
    ensure_zrok_enabled(&bin, token)?;
    let target = format!("http://127.0.0.1:{local_port}");
    let mut command = Command::new(&bin);
    command
        .arg("share")
        .arg("public")
        .arg(&target)
        .arg("--headless")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|err| format!("Не удалось запустить zrok share: {err}"))?;
    let public = wait_for_url_from_child(
        &mut child,
        &["zrok.io", "share.zrok.io"],
        Duration::from_secs(55),
    )?;
    Ok(wrap_handle(child, public, TunnelProvider::Zrok))
}

// --- shared ---------------------------------------------------------------

fn find_file_named(root: &Path, name: &str) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.file_name().is_some_and(|n| n == name) {
                return Some(path);
            }
        }
    }
    None
}

fn github_release_asset_url(repo: &str, name_parts: &[&str]) -> Result<String, String> {
    let api = format!("https://api.github.com/repos/{repo}/releases/latest");
    let response = ureq::get(&api)
        .set("User-Agent", "Drift-p2pchat")
        .set("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(30))
        .call()
        .map_err(|err| format!("GitHub releases {repo}: {err}"))?;
    let body = response.into_string().map_err(|err| err.to_string())?;
    // crude scan for browser_download_url matching all name_parts
    for chunk in body.split("\"browser_download_url\"") {
        let Some(start) = chunk.find("https://") else {
            continue;
        };
        let rest = &chunk[start..];
        let end = rest.find('"').unwrap_or(rest.len());
        let url = &rest[..end];
        let lower = url.to_ascii_lowercase();
        if name_parts.iter().all(|part| lower.contains(&part.to_ascii_lowercase())) {
            return Ok(url.to_string());
        }
    }
    Err(format!("В релизе {repo} не найден asset ({})", name_parts.join("+")))
}

fn download_file(url: &str, dest: &Path) -> Result<(), String> {
    let response = ureq::get(url)
        .set("User-Agent", "Drift-p2pchat")
        .timeout(Duration::from_secs(180))
        .call()
        .map_err(|err| format!("Не удалось скачать {url}: {err}"))?;
    let mut file = File::create(dest).map_err(|err| err.to_string())?;
    let mut reader = response.into_reader();
    std::io::copy(&mut reader, &mut file).map_err(|err| err.to_string())?;
    file.flush().map_err(|err| err.to_string())?;
    Ok(())
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)
        .map_err(|err| err.to_string())?
        .permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).map_err(|err| err.to_string())
}

/// Start the selected tunnel provider to the local hub port.
pub fn start_tunnel(
    app_data: &Path,
    local_port: u16,
    provider: TunnelProvider,
    ngrok_auth_token: &str,
    zrok_token: &str,
) -> Result<(TunnelHandle, TunnelInfo), String> {
    save_tunnel_prefs(app_data, provider, ngrok_auth_token, zrok_token);
    match provider {
        TunnelProvider::Cloudflare => start_cloudflare(app_data, local_port),
        TunnelProvider::Ngrok => start_ngrok(app_data, local_port, ngrok_auth_token),
        TunnelProvider::LocalhostRun => start_localhost_run(local_port),
        TunnelProvider::Pinggy => start_pinggy(local_port),
        TunnelProvider::Bore => start_bore(app_data, local_port),
        TunnelProvider::Zrok => start_zrok(app_data, local_port, zrok_token),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn hashes_file_contents() {
        let dir = std::env::temp_dir().join(format!("drift-sha-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("sample.bin");
        {
            let mut file = File::create(&path).expect("create");
            file.write_all(b"drift-cloudflared-pin").expect("write");
        }
        let digest = file_sha256_hex(&path).expect("hash");
        assert_eq!(
            digest,
            "d48bb636dd03cbd527b9db324550b98b3e619aece6bd89bbfcd3eac3c6652f4c"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

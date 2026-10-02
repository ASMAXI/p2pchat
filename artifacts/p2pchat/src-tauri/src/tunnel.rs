//! Public tunnels for the control plane (chat + signaling).
//! Providers: Cloudflare Quick Tunnel, ngrok, localhost.run.

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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TunnelProvider {
    #[default]
    Cloudflare,
    Ngrok,
    #[serde(rename = "localhostRun", alias = "localhost")]
    LocalhostRun,
}

impl TunnelProvider {
    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "ngrok" => Self::Ngrok,
            "localhost" | "localhostrun" | "localhost_run" | "localhost.run" => Self::LocalhostRun,
            _ => Self::Cloudflare,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cloudflare => "cloudflare",
            Self::Ngrok => "ngrok",
            Self::LocalhostRun => "localhostRun",
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
}

pub fn save_tunnel_prefs(app_data: &Path, provider: TunnelProvider, ngrok_auth_token: &str) {
    let _ = std::fs::create_dir_all(app_data);
    let prefs = TunnelPrefs {
        provider: provider.as_str().to_string(),
        ngrok_auth_token: ngrok_auth_token.to_string(),
    };
    if let Ok(raw) = serde_json::to_string_pretty(&prefs) {
        let _ = std::fs::write(prefs_path(app_data), raw);
    }
}

pub fn load_tunnel_prefs(app_data: &Path) -> (TunnelProvider, String) {
    let raw = std::fs::read_to_string(prefs_path(app_data)).unwrap_or_default();
    let prefs: TunnelPrefs = serde_json::from_str(&raw).unwrap_or_default();
    (
        TunnelProvider::parse(&prefs.provider),
        prefs.ngrok_auth_token,
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

fn extract_https_url(line: &str, host_hint: &str) -> Option<String> {
    let marker = "https://";
    let start = line.find(marker)?;
    let rest = &line[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '|' || c == '"' || c == '\'' || c == ']')
        .unwrap_or(rest.len());
    let candidate = rest[..end].trim_end_matches(['.', ',', ';', ')', ']']);
    if candidate.contains(host_hint) {
        Some(candidate.trim_end_matches('/').to_string())
    } else {
        None
    }
}

fn wait_for_url_from_child(
    child: &mut Child,
    host_hint: &str,
    timeout: Duration,
) -> Result<String, String> {
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "tunnel stderr unavailable".to_string())?;
    let stdout = child.stdout.take();
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let hint = host_hint.to_string();
    let hint2 = hint.clone();
    let tx2 = tx.clone();

    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            if let Some(url) = extract_https_url(&line, &hint) {
                let _ = tx.send(Ok(url));
            }
        }
    });

    if let Some(stdout) = stdout {
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                if let Some(url) = extract_https_url(&line, &hint2) {
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
            return Err(format!(
                "Таймаут: туннель ({host_hint}) не выдал публичный URL"
            ));
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
                return Err(format!(
                    "Таймаут: туннель ({host_hint}) не выдал публичный URL"
                ));
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

fn cloudflared_exe_name() -> &'static str {
    if cfg!(windows) {
        "cloudflared.exe"
    } else {
        "cloudflared"
    }
}

fn cloudflared_download_url() -> &'static str {
    if cfg!(target_os = "windows") {
        "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz"
        } else {
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz"
        }
    } else {
        "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
    }
}

fn ensure_cloudflared(bin_dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(bin_dir).map_err(|err| err.to_string())?;
    let dest = bin_dir.join(cloudflared_exe_name());
    if dest.exists() {
        return Ok(dest);
    }
    let url = cloudflared_download_url();
    if url.ends_with(".tgz") {
        return Err(
            "На macOS положите cloudflared в каталог приложения или установите через brew".into(),
        );
    }
    download_file(url, &dest)?;
    #[cfg(unix)]
    set_executable(&dest)?;
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
    let public = wait_for_url_from_child(&mut child, "trycloudflare.com", Duration::from_secs(45))?;
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
        Err(api_err) => match wait_for_url_from_child(&mut child, "ngrok", Duration::from_secs(10))
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
        "Не найден OpenSSH (ssh). Установите «OpenSSH Client» в Параметры Windows → Приложения → Доп. компоненты, либо выберите Cloudflare/ngrok"
            .into(),
    )
}

fn start_localhost_run(local_port: u16) -> Result<(TunnelHandle, TunnelInfo), String> {
    let ssh = find_ssh()?;
    let remote = format!("80:127.0.0.1:{local_port}");
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
        .arg(&remote)
        .arg("nokey@localhost.run")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|err| format!("Не удалось запустить ssh (localhost.run): {err}"))?;
    let public =
        wait_for_url_from_child(&mut child, "localhost.run", Duration::from_secs(50))?;
    Ok(wrap_handle(child, public, TunnelProvider::LocalhostRun))
}

// --- shared ---------------------------------------------------------------

fn download_file(url: &str, dest: &Path) -> Result<(), String> {
    let response = ureq::get(url)
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
) -> Result<(TunnelHandle, TunnelInfo), String> {
    save_tunnel_prefs(app_data, provider, ngrok_auth_token);
    match provider {
        TunnelProvider::Cloudflare => start_cloudflare(app_data, local_port),
        TunnelProvider::Ngrok => start_ngrok(app_data, local_port, ngrok_auth_token),
        TunnelProvider::LocalhostRun => start_localhost_run(local_port),
    }
}

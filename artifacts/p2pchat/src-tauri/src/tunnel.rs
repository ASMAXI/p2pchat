//! Cloudflare Quick Tunnel (trycloudflare.com) — no ngrok account required.
//! Downloads `cloudflared` once into app data and keeps a child process alive
//! while this desktop is reachable from the internet.

use std::{
    fs::File,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    pub public_origin: String,
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

    // Windows/Linux: direct binary. macOS ships as .tgz — for MVP we only auto-fetch Windows/Linux binaries.
    let url = cloudflared_download_url();
    if url.ends_with(".tgz") {
        return Err(
            "На macOS положите cloudflared в каталог приложения или установите через brew".into(),
        );
    }

    let response = ureq::get(url)
        .timeout(Duration::from_secs(120))
        .call()
        .map_err(|err| format!("Не удалось скачать cloudflared: {err}"))?;
    let mut file = File::create(&dest).map_err(|err| err.to_string())?;
    let mut reader = response.into_reader();
    std::io::copy(&mut reader, &mut file).map_err(|err| err.to_string())?;
    file.flush().map_err(|err| err.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dest)
            .map_err(|err| err.to_string())?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&dest, perms).map_err(|err| err.to_string())?;
    }

    Ok(dest)
}

fn extract_trycloudflare_url(line: &str) -> Option<String> {
    let marker = "https://";
    let start = line.find(marker)?;
    let rest = &line[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '|' || c == '"' || c == '\'')
        .unwrap_or(rest.len());
    let candidate = rest[..end].trim_end_matches(['.', ',', ';', ')']);
    if candidate.contains("trycloudflare.com") {
        Some(candidate.trim_end_matches('/').to_string())
    } else {
        None
    }
}

/// Spawns a Quick Tunnel to `http://127.0.0.1:{port}` and waits for the public HTTPS URL.
pub fn start_quick_tunnel(app_data: &Path, local_port: u16) -> Result<(TunnelHandle, TunnelInfo), String> {
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

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|err| format!("Не удалось запустить cloudflared: {err}"))?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "cloudflared stderr unavailable".to_string())?;
    let stdout = child.stdout.take();

    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let tx_err = tx.clone();

    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            if let Some(url) = extract_trycloudflare_url(&line) {
                let _ = tx.send(Ok(url));
                // Keep draining so the pipe does not block.
            }
        }
    });

    if let Some(stdout) = stdout {
        let tx_out = tx_err;
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                if let Some(url) = extract_trycloudflare_url(&line) {
                    let _ = tx_out.send(Ok(url));
                }
            }
        });
    }

    let deadline = Instant::now() + Duration::from_secs(45);
    let public = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Таймаут: Cloudflare Tunnel не выдал публичный URL".into());
        }
        match rx.recv_timeout(remaining) {
            Ok(Ok(url)) => break url,
            Ok(Err(err)) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(err);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Таймаут: Cloudflare Tunnel не выдал публичный URL".into());
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("cloudflared завершился до выдачи URL".into());
            }
        }
    };

    let handle = TunnelHandle {
        child: Arc::new(Mutex::new(Some(child))),
    };
    Ok((
        handle,
        TunnelInfo {
            public_origin: public,
        },
    ))
}

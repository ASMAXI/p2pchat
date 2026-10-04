//! OS-backed secret vault for identity / room keys.
//! Windows: DPAPI (CryptProtectData). Other OS: file in app data (0600).

use std::{
    fs,
    path::{Path, PathBuf},
};

use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

pub struct SecureVaultState {
    cache: Mutex<Option<String>>,
}

impl Default for SecureVaultState {
    fn default() -> Self {
        Self {
            cache: Mutex::new(None),
        }
    }
}

fn vault_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok((dir.join("secure-vault.bin"), dir.join("secure-vault.json")))
}

#[cfg(windows)]
mod dpapi {
    use std::{mem::MaybeUninit, ptr, slice};

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[link(name = "crypt32")]
    unsafe extern "system" {
        fn CryptProtectData(
            data_in: *mut DataBlob,
            data_descr: *const u16,
            optional_entropy: *mut DataBlob,
            reserved: *mut core::ffi::c_void,
            prompt: *mut core::ffi::c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;

        fn CryptUnprotectData(
            data_in: *mut DataBlob,
            data_descr: *mut *mut u16,
            optional_entropy: *mut DataBlob,
            reserved: *mut core::ffi::c_void,
            prompt: *mut core::ffi::c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;

        fn LocalFree(mem: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let mut input = DataBlob {
                cb_data: plain.len() as u32,
                pb_data: plain.as_ptr() as *mut u8,
            };
            let mut output = MaybeUninit::<DataBlob>::zeroed();
            let ok = CryptProtectData(
                &mut input,
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                0,
                output.as_mut_ptr(),
            );
            if ok == 0 {
                return Err("CryptProtectData failed".into());
            }
            let out = output.assume_init();
            let bytes = slice::from_raw_parts(out.pb_data, out.cb_data as usize).to_vec();
            LocalFree(out.pb_data as *mut _);
            Ok(bytes)
        }
    }

    pub fn unprotect(cipher: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let mut input = DataBlob {
                cb_data: cipher.len() as u32,
                pb_data: cipher.as_ptr() as *mut u8,
            };
            let mut output = MaybeUninit::<DataBlob>::zeroed();
            let ok = CryptUnprotectData(
                &mut input,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                0,
                output.as_mut_ptr(),
            );
            if ok == 0 {
                return Err("CryptUnprotectData failed".into());
            }
            let out = output.assume_init();
            let bytes = slice::from_raw_parts(out.pb_data, out.cb_data as usize).to_vec();
            LocalFree(out.pb_data as *mut _);
            Ok(bytes)
        }
    }
}

fn read_vault_file(bin_path: &Path, json_path: &Path) -> Result<Option<String>, String> {
    if bin_path.exists() {
        let cipher = fs::read(bin_path).map_err(|err| err.to_string())?;
        #[cfg(windows)]
        {
            let plain = dpapi::unprotect(&cipher)?;
            return Ok(Some(
                String::from_utf8(plain).map_err(|err| err.to_string())?,
            ));
        }
        #[cfg(not(windows))]
        {
            let _ = cipher;
        }
    }
    if json_path.exists() {
        let plain = fs::read_to_string(json_path).map_err(|err| err.to_string())?;
        return Ok(Some(plain));
    }
    Ok(None)
}

fn write_vault_file(bin_path: &Path, json_path: &Path, payload: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        let cipher = dpapi::protect(payload.as_bytes())?;
        let tmp = bin_path.with_extension("bin.tmp");
        fs::write(&tmp, &cipher).map_err(|err| err.to_string())?;
        fs::rename(&tmp, bin_path).map_err(|err| err.to_string())?;
        let _ = fs::remove_file(json_path);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let tmp = json_path.with_extension("json.tmp");
        fs::write(&tmp, payload).map_err(|err| err.to_string())?;
        fs::rename(&tmp, json_path).map_err(|err| err.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(json_path, fs::Permissions::from_mode(0o600));
        }
        let _ = bin_path;
        Ok(())
    }
}

#[tauri::command]
pub async fn secure_vault_load(
    app: AppHandle,
    state: State<'_, SecureVaultState>,
) -> Result<Option<String>, String> {
    if let Some(cached) = state.cache.lock().await.clone() {
        return Ok(Some(cached));
    }
    let (bin_path, json_path) = vault_paths(&app)?;
    let loaded = read_vault_file(&bin_path, &json_path)?;
    if let Some(ref payload) = loaded {
        *state.cache.lock().await = Some(payload.clone());
    }
    Ok(loaded)
}

#[tauri::command]
pub async fn secure_vault_save(
    app: AppHandle,
    state: State<'_, SecureVaultState>,
    payload: String,
) -> Result<(), String> {
    if payload.len() > 2_000_000 {
        return Err("Vault too large".into());
    }
    let (bin_path, json_path) = vault_paths(&app)?;
    write_vault_file(&bin_path, &json_path, &payload)?;
    *state.cache.lock().await = Some(payload);
    Ok(())
}

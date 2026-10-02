//! Windows autostart via HKCU Run key (Drift launches with OS).

const VALUE_NAME: &str = "Drift";

#[tauri::command]
pub fn get_autostart_enabled() -> Result<bool, String> {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;
        let key = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(
                r"Software\Microsoft\Windows\CurrentVersion\Run",
                KEY_READ,
            )
            .map_err(|err| err.to_string())?;
        Ok(key.get_value::<String, _>(VALUE_NAME).is_ok())
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

#[tauri::command]
pub fn set_autostart_enabled(enabled: bool) -> Result<bool, String> {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;
        let key = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(
                r"Software\Microsoft\Windows\CurrentVersion\Run",
                KEY_READ | KEY_WRITE,
            )
            .map_err(|err| err.to_string())?;
        if enabled {
            let exe = std::env::current_exe()
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|err| err.to_string())?;
            key.set_value(VALUE_NAME, &exe)
                .map_err(|err| err.to_string())?;
        } else {
            let _ = key.delete_value(VALUE_NAME);
        }
        Ok(enabled)
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("Автозапуск пока только для Windows".into())
    }
}

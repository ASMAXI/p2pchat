; Drift NSIS hooks — wipe only known app folders/keys on uninstall.
; Never touch parent AppData / Program Files / other apps.
; ${BUNDLEID} = com.p2pchat.desktop (from tauri.conf identifier)
; $UpdateMode = 1 during in-place update installs — skip wipe then.

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    SetShellVarContext current

    ; Roaming: node.sqlite, cloudflared bin/, tunnel-prefs.json
    RmDir /r "$APPDATA\${BUNDLEID}"

    ; Local: WebView2 profile (localStorage, cache, cookies for the UI)
    RmDir /r "$LOCALAPPDATA\${BUNDLEID}"

    ; Cached update installers downloaded by the in-app updater
    RmDir /r "$TEMP\drift-update"

    ; Autostart (also cleared by Tauri for ${PRODUCTNAME}; keep explicit)
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Drift"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"

    ; Deep-link schemes registered at runtime (HKCU) via register_all
    DeleteRegKey HKCU "Software\Classes\drift"
    DeleteRegKey HKCU "Software\Classes\p2pchat"
  ${EndIf}
!macroend

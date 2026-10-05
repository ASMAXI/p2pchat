const FUN_SOUNDS_KEY = "p2pchat-fun-sounds";
const DESKTOP_NOTIFY_KEY = "p2pchat-desktop-notify";

export function loadFunSoundsEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem(FUN_SOUNDS_KEY);
    if (raw === null) return true;
    return raw !== "0" && raw !== "false";
  } catch {
    return true;
  }
}

export function saveFunSoundsEnabled(enabled: boolean): void {
  window.localStorage.setItem(FUN_SOUNDS_KEY, enabled ? "1" : "0");
}

export function loadDesktopNotifyEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem(DESKTOP_NOTIFY_KEY);
    if (raw === null) return true;
    return raw !== "0" && raw !== "false";
  } catch {
    return true;
  }
}

export function saveDesktopNotifyEnabled(enabled: boolean): void {
  window.localStorage.setItem(DESKTOP_NOTIFY_KEY, enabled ? "1" : "0");
}

import { debugLog } from "@/lib/debug-log";
import { loadDesktopNotifyEnabled } from "@/lib/notify-settings";

export type NotifyKind = "message" | "voice-join" | "voice-leave" | "mention";

function isDesktop(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

async function windowHidden(): Promise<boolean> {
  if (document.visibilityState === "hidden") return true;
  if (!isDesktop()) return false;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return !(await getCurrentWindow().isVisible()) || !(await getCurrentWindow().isFocused());
  } catch {
    return document.visibilityState !== "visible";
  }
}

/** Windows toast / Notification API when the app is in background. */
export async function notifyDesktop(kind: NotifyKind, title: string, body: string): Promise<void> {
  if (!loadDesktopNotifyEnabled()) return;
  if (!(await windowHidden())) return;
  try {
    if (isDesktop()) {
      const { isPermissionGranted, requestPermission, sendNotification } = await import(
        "@tauri-apps/plugin-notification"
      );
      let granted = await isPermissionGranted();
      if (!granted) {
        const permission = await requestPermission();
        granted = permission === "granted";
      }
      if (granted) {
        sendNotification({ title, body });
        return;
      }
    }
  } catch (error) {
    debugLog("notify", "tauri notification failed", error, "warn");
  }
  try {
    if ("Notification" in window) {
      if (Notification.permission === "default") await Notification.requestPermission();
      if (Notification.permission === "granted") {
        new Notification(title, { body, silent: kind === "message" });
      }
    }
  } catch (error) {
    debugLog("notify", "web notification failed", error, "warn");
  }
}

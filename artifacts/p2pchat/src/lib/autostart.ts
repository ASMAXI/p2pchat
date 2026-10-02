async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(command, args);
}

function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function getAutostartEnabled(): Promise<boolean> {
  if (!isDesktop()) return false;
  try {
    return await invoke<boolean>("get_autostart_enabled");
  } catch {
    return false;
  }
}

export async function setAutostartEnabled(enabled: boolean): Promise<boolean> {
  if (!isDesktop()) throw new Error("Автозапуск доступен только в desktop-сборке");
  return invoke<boolean>("set_autostart_enabled", { enabled });
}

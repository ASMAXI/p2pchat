export type LocalNodeInfo = {
  origin: string;
  lanOrigins: string[];
};

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(command, args);
}

/** Starts the embedded peer node inside the Tauri shell (no-op in the browser). */
export async function ensureLocalNode(): Promise<LocalNodeInfo | null> {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  try {
    return await invoke<LocalNodeInfo>("start_local_sync_server");
  } catch {
    return null;
  }
}

/** @deprecated use ensureLocalNode */
export const ensureLocalSyncServer = ensureLocalNode;

export function pickInviteApiOrigin(info: LocalNodeInfo | null, fallback: string): string {
  if (!info) return fallback;
  return info.lanOrigins[0] ?? info.origin;
}

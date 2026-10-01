import { debugLog } from "@/lib/debug-log";

export type LocalNodeInfo = {
  origin: string;
  lanOrigins: string[];
  publicOrigin?: string | null;
  tunnelError?: string | null;
};

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(command, args);
}

/** Starts the embedded peer node + Cloudflare Quick Tunnel (no-op in the browser). */
export async function ensureLocalNode(): Promise<LocalNodeInfo | null> {
  if (!("__TAURI_INTERNALS__" in window)) {
    debugLog("node", "ensureLocalNode skipped (not desktop)");
    return null;
  }
  try {
    debugLog("node", "start_local_sync_server…");
    const info = await invoke<LocalNodeInfo>("start_local_sync_server");
    debugLog(
      "node",
      "local node ready",
      {
        origin: info.origin,
        lan: info.lanOrigins,
        publicOrigin: info.publicOrigin,
        tunnelError: info.tunnelError,
      },
      info.tunnelError ? "warn" : "info",
    );
    return info;
  } catch (error) {
    debugLog("node", "start_local_sync_server failed", error, "error");
    return null;
  }
}

export async function restartPublicTunnel(): Promise<LocalNodeInfo | null> {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  try {
    debugLog("tunnel", "restart_public_tunnel…");
    const info = await invoke<LocalNodeInfo>("restart_public_tunnel");
    debugLog(
      "tunnel",
      "restart result",
      {
        publicOrigin: info.publicOrigin,
        tunnelError: info.tunnelError,
      },
      info.tunnelError ? "warn" : "info",
    );
    return info;
  } catch (error) {
    debugLog("tunnel", "restart failed", error, "error");
    return null;
  }
}

/** @deprecated use ensureLocalNode */
export const ensureLocalSyncServer = ensureLocalNode;

export function pickInviteApiOrigin(info: LocalNodeInfo | null, fallback: string): string {
  if (!info) return fallback;
  return info.publicOrigin || info.lanOrigins[0] || info.origin || fallback;
}

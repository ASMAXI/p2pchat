import type { IdentityStorage } from "@workspace/p2p-identity";

const IDENTITY_KEY = "p2pchat-crypto-identity";
const ROOM_META_KEY = "p2pchat-room-meta";
const SAVED_SERVERS_KEY = "p2pchat-saved-servers";
const MIGRATED_FLAG = "p2pchat-secure-vault-migrated";

type VaultPayload = {
  identity?: string | null;
  roomMeta?: string | null;
  savedServers?: string | null;
};

let vault: VaultPayload = {};
let hydrated = false;
let persistChain: Promise<void> = Promise.resolve();

function canUseNativeVault(): boolean {
  return "__TAURI_INTERNALS__" in window || window.location.hostname.endsWith("tauri.localhost");
}

async function nativeLoad(): Promise<VaultPayload | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<string | null>("secure_vault_load");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as VaultPayload;
  } catch {
    return null;
  }
}

async function nativeSave(next: VaultPayload): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("secure_vault_save", { payload: JSON.stringify(next) });
}

function schedulePersist(): void {
  if (!canUseNativeVault()) return;
  const snapshot = { ...vault };
  persistChain = persistChain
    .then(() => nativeSave(snapshot))
    .catch(() => {
      // Keep memory vault; next write retries.
    });
}

function migrateLocalSecretsIntoVault(): boolean {
  let changed = false;
  try {
    if (window.localStorage.getItem(MIGRATED_FLAG) === "1" && (vault.identity || vault.roomMeta || vault.savedServers)) {
      return false;
    }
  } catch {
    // ignore
  }

  try {
    const identity = window.localStorage.getItem(IDENTITY_KEY);
    if (identity && !vault.identity) {
      vault.identity = identity;
      window.localStorage.removeItem(IDENTITY_KEY);
      changed = true;
    }
  } catch {
    // ignore
  }

  try {
    const roomMeta = window.localStorage.getItem(ROOM_META_KEY);
    if (roomMeta && !vault.roomMeta) {
      vault.roomMeta = roomMeta;
      window.localStorage.removeItem(ROOM_META_KEY);
      changed = true;
    }
  } catch {
    // ignore
  }

  try {
    const saved = window.localStorage.getItem(SAVED_SERVERS_KEY);
    if (saved && !vault.savedServers) {
      vault.savedServers = saved;
      // Keep a redacted public list? For now move entirely to vault.
      window.localStorage.removeItem(SAVED_SERVERS_KEY);
      changed = true;
    }
  } catch {
    // ignore
  }

  if (changed) {
    try {
      window.localStorage.setItem(MIGRATED_FLAG, "1");
    } catch {
      // ignore
    }
  }
  return changed;
}

/** Call once at desktop app boot before reading identity / room secrets. */
export async function hydrateSecureStorage(): Promise<void> {
  if (hydrated) return;
  if (!canUseNativeVault()) {
    hydrated = true;
    return;
  }
  try {
    const loaded = await nativeLoad();
    if (loaded) vault = { ...vault, ...loaded };
  } catch {
    // Fall through to localStorage migration / usage.
  }
  if (migrateLocalSecretsIntoVault()) schedulePersist();
  hydrated = true;
}

export function getSecureIdentityRaw(): string | null {
  return vault.identity ?? (canUseNativeVault() ? null : window.localStorage.getItem(IDENTITY_KEY));
}

export function setSecureIdentityRaw(value: string | null): void {
  vault.identity = value;
  try {
    window.localStorage.removeItem(IDENTITY_KEY);
  } catch {
    // ignore
  }
  if (!canUseNativeVault()) {
    if (value) window.localStorage.setItem(IDENTITY_KEY, value);
    else window.localStorage.removeItem(IDENTITY_KEY);
    return;
  }
  schedulePersist();
}

export function getSecureRoomMetaRaw(): string | null {
  return vault.roomMeta ?? (canUseNativeVault() ? null : window.localStorage.getItem(ROOM_META_KEY));
}

export function setSecureRoomMetaRaw(value: string | null): void {
  vault.roomMeta = value;
  try {
    window.localStorage.removeItem(ROOM_META_KEY);
  } catch {
    // ignore
  }
  if (!canUseNativeVault()) {
    if (value) window.localStorage.setItem(ROOM_META_KEY, value);
    else window.localStorage.removeItem(ROOM_META_KEY);
    return;
  }
  schedulePersist();
}

export function getSecureSavedServersRaw(): string | null {
  return vault.savedServers ?? (canUseNativeVault() ? null : window.localStorage.getItem(SAVED_SERVERS_KEY));
}

export function setSecureSavedServersRaw(value: string | null): void {
  vault.savedServers = value;
  try {
    window.localStorage.removeItem(SAVED_SERVERS_KEY);
  } catch {
    // ignore
  }
  if (!canUseNativeVault()) {
    if (value) window.localStorage.setItem(SAVED_SERVERS_KEY, value);
    else window.localStorage.removeItem(SAVED_SERVERS_KEY);
    return;
  }
  schedulePersist();
}

/** Sync Storage facade for @workspace/p2p-identity. */
export function createSecureIdentityStorage(): IdentityStorage {
  return {
    getItem(key: string): string | null {
      if (key === IDENTITY_KEY) return getSecureIdentityRaw();
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key: string, value: string): void {
      if (key === IDENTITY_KEY) {
        setSecureIdentityRaw(value);
        return;
      }
      window.localStorage.setItem(key, value);
    },
    removeItem(key: string): void {
      if (key === IDENTITY_KEY) {
        setSecureIdentityRaw(null);
        return;
      }
      window.localStorage.removeItem(key);
    },
  };
}

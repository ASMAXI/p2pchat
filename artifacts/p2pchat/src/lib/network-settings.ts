import { normalizeOrigin } from "@workspace/p2p-protocol";

const ICE_KEY = "p2pchat-ice-servers";
const PUBLIC_URL_KEY = "p2pchat-public-url";
const ICE_CACHE_KEY = "p2pchat-ice-cache";
const MANUAL_PUBLIC_URL_KEY = "p2pchat-public-url-manual";

export type TurnConfig = {
  urls: string;
  username: string;
  credential: string;
};

export type IceSettings = {
  turn: TurnConfig | null;
};

/** Free Open Relay defaults (best-effort). Override via Settings or VITE_METERED_API_KEY for Pro/stable. */
export const DEFAULT_FREE_TURN: TurnConfig = {
  urls: "turn:openrelay.metered.ca:80",
  username: "openrelayproject",
  credential: "openrelayproject",
};

const DEFAULT_STUN: RTCIceServer = { urls: "stun:stun.l.google.com:19302" };
const DEFAULT_STUN_METERED: RTCIceServer = { urls: "stun:stun.relay.metered.ca:80" };

export function loadIceSettings(): IceSettings {
  try {
    const raw = window.localStorage.getItem(ICE_KEY);
    if (!raw) return { turn: null };
    const parsed = JSON.parse(raw) as IceSettings;
    if (!parsed?.turn?.urls) return { turn: null };
    return {
      turn: {
        urls: String(parsed.turn.urls).trim(),
        username: String(parsed.turn.username ?? "").trim(),
        credential: String(parsed.turn.credential ?? "").trim(),
      },
    };
  } catch {
    return { turn: null };
  }
}

export function saveIceSettings(settings: IceSettings): void {
  window.localStorage.setItem(ICE_KEY, JSON.stringify(settings));
}

/** Custom TURN from settings wins; otherwise built-in free TURN (path 1). */
export function effectiveTurn(settings: IceSettings = loadIceSettings()): TurnConfig {
  if (settings.turn?.urls && settings.turn.username && settings.turn.credential) {
    return settings.turn;
  }
  return DEFAULT_FREE_TURN;
}

export function isTurnConfigured(settings: IceSettings = loadIceSettings()): boolean {
  const turn = effectiveTurn(settings);
  return Boolean(turn.urls && turn.username && turn.credential);
}

export function isCustomTurnConfigured(settings: IceSettings = loadIceSettings()): boolean {
  return Boolean(settings.turn?.urls && settings.turn.username && settings.turn.credential);
}

export function buildIceServers(settings: IceSettings = loadIceSettings()): RTCIceServer[] {
  const cached = readIceCache();
  if (cached?.length) return cached;

  const turn = effectiveTurn(settings);
  return [
    DEFAULT_STUN,
    DEFAULT_STUN_METERED,
    {
      urls: turn.urls,
      username: turn.username,
      credential: turn.credential,
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: turn.username,
      credential: turn.credential,
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: turn.username,
      credential: turn.credential,
    },
  ];
}

type IceCache = { at: number; servers: RTCIceServer[] };

function readIceCache(): RTCIceServer[] | null {
  try {
    const raw = window.localStorage.getItem(ICE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as IceCache;
    if (!parsed?.servers?.length) return null;
    if (Date.now() - parsed.at > 6 * 60 * 60 * 1000) return null;
    return parsed.servers;
  } catch {
    return null;
  }
}

function writeIceCache(servers: RTCIceServer[]): void {
  window.localStorage.setItem(ICE_CACHE_KEY, JSON.stringify({ at: Date.now(), servers } satisfies IceCache));
}

/**
 * Prefer Metered REST credentials when VITE_METERED_API_KEY is set (future Pro / your account).
 * Falls back to built-in free TURN.
 */
export async function warmIceServers(): Promise<RTCIceServer[]> {
  if (isCustomTurnConfigured()) {
    const servers = buildIceServers();
    return servers;
  }

  const apiKey = import.meta.env.VITE_METERED_API_KEY as string | undefined;
  const appName = (import.meta.env.VITE_METERED_APP_NAME as string | undefined) || "p2pchat";
  if (apiKey) {
    try {
      const response = await fetch(
        `https://${appName}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`,
      );
      if (response.ok) {
        const iceServers = (await response.json()) as RTCIceServer[];
        if (Array.isArray(iceServers) && iceServers.length > 0) {
          writeIceCache(iceServers);
          return iceServers;
        }
      }
    } catch {
      // Fall through to defaults.
    }
  }

  const servers = buildIceServers();
  return servers;
}

export function getPublicUrl(): string {
  return normalizeOrigin(window.localStorage.getItem(PUBLIC_URL_KEY)?.trim() ?? "");
}

export function isManualPublicUrl(): boolean {
  return window.localStorage.getItem(MANUAL_PUBLIC_URL_KEY) === "1";
}

export function setPublicUrl(origin: string, options?: { manual?: boolean }): void {
  const normalized = normalizeOrigin(origin);
  if (normalized) {
    window.localStorage.setItem(PUBLIC_URL_KEY, normalized);
    if (options?.manual) window.localStorage.setItem(MANUAL_PUBLIC_URL_KEY, "1");
  } else {
    window.localStorage.removeItem(PUBLIC_URL_KEY);
    window.localStorage.removeItem(MANUAL_PUBLIC_URL_KEY);
  }
}

/** Auto tunnel may refresh the public URL unless the user pinned one manually. */
export function applyAutoPublicUrl(origin: string): void {
  if (isManualPublicUrl()) return;
  const normalized = normalizeOrigin(origin);
  if (normalized) window.localStorage.setItem(PUBLIC_URL_KEY, normalized);
}

export function isPublicHttpOrigin(origin: string): boolean {
  try {
    const url = new URL(normalizeOrigin(origin));
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname;
    return host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]";
  } catch {
    return false;
  }
}

/** Prefer public/tunnel URL, then LAN, never put loopback first for invites. */
export function orderInviteOrigins(origins: string[]): string[] {
  const unique = origins
    .map(normalizeOrigin)
    .filter(Boolean)
    .filter((origin, index, list) => list.indexOf(origin) === index);
  const publicOnes = unique.filter((origin) => {
    try {
      const host = new URL(origin).hostname;
      return (
        host !== "localhost" &&
        host !== "127.0.0.1" &&
        host !== "[::1]" &&
        !host.startsWith("192.168.") &&
        !host.startsWith("10.") &&
        !/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
      );
    } catch {
      return false;
    }
  });
  const lan = unique.filter((origin) => !publicOnes.includes(origin) && isPublicHttpOrigin(origin));
  const rest = unique.filter((origin) => !publicOnes.includes(origin) && !lan.includes(origin));
  const tunnels = unique.filter((origin) => /ngrok|trycloudflare|cloudflare|loca\.lt|serveo/i.test(origin));
  return [...new Set([...publicOnes, ...tunnels, ...lan, ...rest])];
}

/**
 * Join/bootstrap order: try LAN before ephemeral trycloudflare URLs.
 * Stale Quick Tunnel hostnames fail slowly; same-Wi‑Fi peers should hit LAN first.
 */
export function orderBootstrapOrigins(origins: string[]): string[] {
  const unique = origins
    .map(normalizeOrigin)
    .filter(Boolean)
    .filter((origin, index, list) => list.indexOf(origin) === index);
  const loopback: string[] = [];
  const lan: string[] = [];
  const publicOnes: string[] = [];
  for (const origin of unique) {
    try {
      const host = new URL(origin).hostname;
      if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") loopback.push(origin);
      else if (
        host.startsWith("192.168.") ||
        host.startsWith("10.") ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
      ) {
        lan.push(origin);
      } else publicOnes.push(origin);
    } catch {
      publicOnes.push(origin);
    }
  }
  return [...lan, ...publicOnes, ...loopback];
}

export function collectNodeEndpoints(localNode: {
  origin: string;
  lanOrigins: string[];
  publicOrigin?: string | null;
} | null): string[] {
  const publicUrl = getPublicUrl() || normalizeOrigin(localNode?.publicOrigin ?? "");
  const list = [
    ...(publicUrl ? [publicUrl] : []),
    ...(localNode?.lanOrigins ?? []),
    ...(localNode ? [localNode.origin] : []),
  ];
  return orderInviteOrigins(list);
}

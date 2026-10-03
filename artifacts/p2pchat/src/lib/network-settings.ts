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
  /** Metered free-tier API key — REST credentials work; static openrelayproject often does not. */
  meteredApiKey?: string | null;
  meteredAppName?: string | null;
};

export type IceSource = "custom-turn" | "metered-api" | "static-openrelay" | "cache";

let lastIceSource: IceSource = "static-openrelay";

/** Legacy static Open Relay — frequently dead; kept as last-resort fallback only. */
export const DEFAULT_FREE_TURN: TurnConfig = {
  urls: "turn:openrelay.metered.ca:80",
  username: "openrelayproject",
  credential: "openrelayproject",
};

const DEFAULT_STUN: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.relay.metered.ca:80" },
];

export function loadIceSettings(): IceSettings {
  try {
    const raw = window.localStorage.getItem(ICE_KEY);
    if (!raw) return { turn: null };
    const parsed = JSON.parse(raw) as IceSettings;
    const turn =
      parsed?.turn?.urls
        ? {
            urls: String(parsed.turn.urls).trim(),
            username: String(parsed.turn.username ?? "").trim(),
            credential: String(parsed.turn.credential ?? "").trim(),
          }
        : null;
    return {
      turn,
      meteredApiKey: parsed.meteredApiKey ? String(parsed.meteredApiKey).trim() : null,
      meteredAppName: parsed.meteredAppName ? String(parsed.meteredAppName).trim() : null,
    };
  } catch {
    return { turn: null };
  }
}

export function saveIceSettings(settings: IceSettings): void {
  window.localStorage.setItem(ICE_KEY, JSON.stringify(settings));
  clearIceCache();
}

/** Custom TURN from settings wins; otherwise built-in free TURN (path 1). */
export function effectiveTurn(settings: IceSettings = loadIceSettings()): TurnConfig {
  if (settings.turn?.urls && settings.turn.username && settings.turn.credential) {
    return settings.turn;
  }
  return DEFAULT_FREE_TURN;
}

export function isTurnConfigured(settings: IceSettings = loadIceSettings()): boolean {
  if (resolveMeteredApiKey(settings)) return true;
  const turn = effectiveTurn(settings);
  return Boolean(turn.urls && turn.username && turn.credential);
}

export function isCustomTurnConfigured(settings: IceSettings = loadIceSettings()): boolean {
  return Boolean(settings.turn?.urls && settings.turn.username && settings.turn.credential);
}

export function getLastIceSource(): IceSource {
  return lastIceSource;
}

function resolveMeteredApiKey(settings: IceSettings = loadIceSettings()): string | undefined {
  const fromSettings = settings.meteredApiKey?.trim();
  if (fromSettings) return fromSettings;
  const fromEnv = (import.meta.env.VITE_METERED_API_KEY as string | undefined)?.trim();
  return fromEnv || undefined;
}

function resolveMeteredAppName(settings: IceSettings = loadIceSettings()): string {
  return (
    settings.meteredAppName?.trim() ||
    (import.meta.env.VITE_METERED_APP_NAME as string | undefined)?.trim() ||
    "p2pchat"
  );
}

function staticOpenRelayServers(turn: TurnConfig): RTCIceServer[] {
  const auth = { username: turn.username, credential: turn.credential };
  return [
    ...DEFAULT_STUN,
    { urls: turn.urls, ...auth },
    { urls: "turn:openrelay.metered.ca:80?transport=tcp", ...auth },
    { urls: "turn:openrelay.metered.ca:443", ...auth },
    { urls: "turn:openrelay.metered.ca:443?transport=tcp", ...auth },
    { urls: "turns:openrelay.metered.ca:443", ...auth },
  ];
}

export function buildIceServers(settings: IceSettings = loadIceSettings()): RTCIceServer[] {
  const cached = readIceCache();
  if (cached?.length) {
    lastIceSource = "cache";
    return cached;
  }

  if (isCustomTurnConfigured(settings)) {
    lastIceSource = "custom-turn";
    const turn = effectiveTurn(settings);
    return [
      ...DEFAULT_STUN,
      {
        urls: turn.urls.split(/[\s,]+/).filter(Boolean),
        username: turn.username,
        credential: turn.credential,
      },
    ];
  }

  lastIceSource = "static-openrelay";
  return staticOpenRelayServers(DEFAULT_FREE_TURN);
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

export function clearIceCache(): void {
  window.localStorage.removeItem(ICE_CACHE_KEY);
}

/**
 * Prefer: custom TURN → Metered REST (settings or VITE_METERED_API_KEY) → static openrelay fallback.
 * Static openrelayproject credentials are often non-functional; Metered API key is required for
 * reliable voice across different NATs.
 */
export async function warmIceServers(): Promise<RTCIceServer[]> {
  const settings = loadIceSettings();
  if (isCustomTurnConfigured(settings)) {
    lastIceSource = "custom-turn";
    return buildIceServers(settings);
  }

  const cached = readIceCache();
  if (cached?.length) {
    lastIceSource = "cache";
    return cached;
  }

  const apiKey = resolveMeteredApiKey(settings);
  const appName = resolveMeteredAppName(settings);
  if (apiKey) {
    try {
      const response = await fetch(
        `https://${appName}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`,
      );
      if (response.ok) {
        const iceServers = (await response.json()) as RTCIceServer[];
        if (Array.isArray(iceServers) && iceServers.length > 0) {
          writeIceCache(iceServers);
          lastIceSource = "metered-api";
          return iceServers;
        }
      }
    } catch {
      // Fall through to defaults.
    }
  }

  lastIceSource = "static-openrelay";
  return staticOpenRelayServers(DEFAULT_FREE_TURN);
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
  const tunnels = unique.filter((origin) =>
    /ngrok|trycloudflare|cloudflare|loca\.lt|serveo|localhost\.run|pinggy|bore\.pub|zrok\.io/i.test(
      origin,
    ),
  );
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

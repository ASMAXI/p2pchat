/**
 * Temporary debug ring-buffer for beta testing with friends.
 * Copy/download from Diagnostics — remove or gate later.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type DebugLogEntry = {
  ts: string;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
};

const STORAGE_KEY = "p2pchat-debug-log";
const MAX_ENTRIES = 800;

let entries: DebugLogEntry[] = loadPersisted();
const listeners = new Set<() => void>();

function loadPersisted(): DebugLogEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DebugLogEntry[];
    return Array.isArray(parsed) ? parsed.slice(-MAX_ENTRIES) : [];
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    // Quota — drop older half.
    entries = entries.slice(-Math.floor(MAX_ENTRIES / 2));
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      /* ignore */
    }
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

const SECRET_KEY =
  /^(inviteToken|invite_token|roomKey|room_key|privateKey|private_key|authToken|auth_token|token|password|secret|ngrok|zrok)$/i;

function redactValue(key: string, value: unknown): unknown {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "string" && /(?:inviteToken|roomKey|privateKey|authToken)=/i.test(value)) {
    return value
      .replace(/(inviteToken|roomKey|privateKey|authToken|token)=([^&\s#]+)/gi, "$1=[redacted]")
      .replace(/(drift|p2pchat):\/\/[^\s"']+/gi, "[invite-redacted]");
  }
  return value;
}

function redactDeep(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(redactDeep);
  if (typeof value !== "object") return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactValue("message", value.message),
      stack: value.stack,
    };
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactDeep(redactValue(key, child));
  }
  return out;
}

function safeData(data: unknown): unknown {
  if (data == null) return undefined;
  if (typeof data === "string" || typeof data === "number" || typeof data === "boolean") {
    return redactValue("value", data);
  }
  try {
    return redactDeep(JSON.parse(JSON.stringify(data)));
  } catch {
    return String(data);
  }
}

export function debugLog(scope: string, message: string, data?: unknown, level: LogLevel = "info"): void {
  const entry: DebugLogEntry = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    data: safeData(data),
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  persist();
  notify();
  const line = `[${entry.ts}] ${level.toUpperCase()} [${scope}] ${message}`;
  if (level === "error") console.error(line, data ?? "");
  else if (level === "warn") console.warn(line, data ?? "");
  else console.info(line, data ?? "");
}

export function getDebugLogs(): DebugLogEntry[] {
  return [...entries];
}

export function clearDebugLogs(): void {
  entries = [];
  persist();
  notify();
}

export function subscribeDebugLogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let reportEnricher: (() => Record<string, unknown>) | null = null;

/** Register extra header fields (e.g. voice NAT) without circular imports. */
export function setDebugReportEnricher(fn: (() => Record<string, unknown>) | null): void {
  reportEnricher = fn;
}

export function formatDebugReport(extra?: Record<string, unknown>): string {
  let enriched: Record<string, unknown> = {};
  try {
    enriched = reportEnricher?.() ?? {};
  } catch {
    enriched = {};
  }
  const header = {
    generatedAt: new Date().toISOString(),
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    href: typeof location !== "undefined" ? location.href : "",
    peerId: (() => {
      try {
        const raw = window.localStorage.getItem("p2pchat-crypto-identity");
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { peerId?: string };
        return parsed.peerId ?? null;
      } catch {
        return null;
      }
    })(),
    roomMeta: (() => {
      try {
        const raw = window.localStorage.getItem("p2pchat-room-meta");
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { roomId?: string; bootstrapOrigins?: string[]; invite?: string };
        return {
          roomId: parsed.roomId,
          bootstrap: parsed.bootstrapOrigins?.slice(0, 6),
          inviteOrigins: parsed.invite
            ? [...new URLSearchParams(parsed.invite.split("?")[1] ?? "").getAll("api")].slice(0, 6)
            : [],
        };
      } catch {
        return null;
      }
    })(),
    publicUrl: window.localStorage.getItem("p2pchat-public-url"),
    bootstrap: window.localStorage.getItem("p2pchat-api-origin"),
    iceConfigured: Boolean(window.localStorage.getItem("p2pchat-ice-servers")),
    iceCache: Boolean(window.localStorage.getItem("p2pchat-ice-cache")),
    connection: window.localStorage.getItem("p2pchat-connection-status"),
    ...enriched,
    ...extra,
  };

  const lines = [
    "=== Drift debug report (temporary) ===",
    JSON.stringify(header, null, 2),
    "=== events ===",
    ...entries.map((entry) => {
      const payload = entry.data !== undefined ? ` ${JSON.stringify(entry.data)}` : "";
      return `${entry.ts} ${entry.level.padEnd(5)} [${entry.scope}] ${entry.message}${payload}`;
    }),
    "=== end ===",
  ];
  return lines.join("\n");
}

export async function copyDebugReport(extra?: Record<string, unknown>): Promise<boolean> {
  const text = formatDebugReport(extra);
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function downloadDebugReport(extra?: Record<string, unknown>): void {
  const text = formatDebugReport(extra);
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const a = document.createElement("a");
  a.href = url;
  a.download = `p2pchat-debug-${stamp}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Capture unhandled errors into the ring buffer. */
export function installDebugLogHooks(): void {
  window.addEventListener("error", (event) => {
    debugLog("window", event.message || "error", { filename: event.filename, lineno: event.lineno }, "error");
  });
  window.addEventListener("unhandledrejection", (event) => {
    debugLog("window", "unhandledrejection", event.reason, "error");
  });
}

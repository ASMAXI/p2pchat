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

function safeData(data: unknown): unknown {
  if (data == null) return undefined;
  if (typeof data === "string" || typeof data === "number" || typeof data === "boolean") return data;
  if (data instanceof Error) return { name: data.name, message: data.message, stack: data.stack };
  try {
    return JSON.parse(JSON.stringify(data));
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

export function formatDebugReport(extra?: Record<string, unknown>): string {
  const header = {
    generatedAt: new Date().toISOString(),
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    href: typeof location !== "undefined" ? location.href : "",
    peerId: (() => {
      try {
        return window.localStorage.getItem("p2pchat-identity")?.slice(0, 80) ?? null;
      } catch {
        return null;
      }
    })(),
    publicUrl: window.localStorage.getItem("p2pchat-public-url"),
    bootstrap: window.localStorage.getItem("p2pchat-api-origin"),
    iceConfigured: window.localStorage.getItem("p2pchat-ice-servers"),
    connection: window.localStorage.getItem("p2pchat-connection-status"),
    ...extra,
  };

  const lines = [
    "=== P2PChat debug report (temporary) ===",
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

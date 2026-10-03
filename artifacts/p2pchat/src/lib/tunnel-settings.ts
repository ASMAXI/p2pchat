const PROVIDER_KEY = "p2pchat-tunnel-provider";
const NGROK_TOKEN_KEY = "p2pchat-ngrok-auth-token";
const ZROK_TOKEN_KEY = "p2pchat-zrok-token";

export type TunnelProviderId =
  | "cloudflare"
  | "ngrok"
  | "localhostRun"
  | "pinggy"
  | "bore"
  | "zrok";

export const TUNNEL_PROVIDER_OPTIONS: Array<{
  id: TunnelProviderId;
  label: string;
  hint: string;
}> = [
  {
    id: "cloudflare",
    label: "Cloudflare",
    hint: "Без аккаунта. Иногда режется провайдером / VPN.",
  },
  {
    id: "pinggy",
    label: "Pinggy",
    hint: "Без аккаунта, через SSH. Free-туннель ~60 мин, потом новый URL.",
  },
  {
    id: "ngrok",
    label: "ngrok",
    hint: "Нужен бесплатный authtoken — обычно стабильнее CF.",
  },
  {
    id: "localhostRun",
    label: "localhost.run",
    hint: "Через OpenSSH, без аккаунта.",
  },
  {
    id: "bore",
    label: "Bore",
    hint: "Без аккаунта, TCP→HTTP на bore.pub (не HTTPS). Скачает binary сам.",
  },
  {
    id: "zrok",
    label: "zrok",
    hint: "Нужен token с zrok.io. HTTPS, иногда interstitial-страница на free.",
  },
];

const VALID = new Set<TunnelProviderId>(TUNNEL_PROVIDER_OPTIONS.map((o) => o.id));

export function loadTunnelProvider(): TunnelProviderId {
  const raw = window.localStorage.getItem(PROVIDER_KEY)?.trim();
  if (raw && VALID.has(raw as TunnelProviderId)) return raw as TunnelProviderId;
  if (raw === "localhost" || raw === "localhost.run") return "localhostRun";
  return "cloudflare";
}

export function saveTunnelProvider(provider: TunnelProviderId): void {
  window.localStorage.setItem(PROVIDER_KEY, provider);
}

export function loadNgrokAuthToken(): string {
  return window.localStorage.getItem(NGROK_TOKEN_KEY)?.trim() ?? "";
}

export function saveNgrokAuthToken(token: string): void {
  const value = token.trim();
  if (value) window.localStorage.setItem(NGROK_TOKEN_KEY, value);
  else window.localStorage.removeItem(NGROK_TOKEN_KEY);
}

export function loadZrokToken(): string {
  return window.localStorage.getItem(ZROK_TOKEN_KEY)?.trim() ?? "";
}

export function saveZrokToken(token: string): void {
  const value = token.trim();
  if (value) window.localStorage.setItem(ZROK_TOKEN_KEY, value);
  else window.localStorage.removeItem(ZROK_TOKEN_KEY);
}

export function tunnelInvokeArgs(): {
  provider: TunnelProviderId;
  ngrokAuthToken: string;
  zrokToken: string;
} {
  return {
    provider: loadTunnelProvider(),
    ngrokAuthToken: loadNgrokAuthToken(),
    zrokToken: loadZrokToken(),
  };
}

const PROVIDER_KEY = "p2pchat-tunnel-provider";
const NGROK_TOKEN_KEY = "p2pchat-ngrok-auth-token";

export type TunnelProviderId = "cloudflare" | "ngrok" | "localhostRun";

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
    id: "ngrok",
    label: "ngrok",
    hint: "Нужен бесплатный authtoken с ngrok.com — обычно стабильнее CF.",
  },
  {
    id: "localhostRun",
    label: "localhost.run",
    hint: "Через OpenSSH, без аккаунта. Нужен «OpenSSH Client» в Windows.",
  },
];

export function loadTunnelProvider(): TunnelProviderId {
  const raw = window.localStorage.getItem(PROVIDER_KEY)?.trim();
  if (raw === "ngrok" || raw === "localhostRun" || raw === "cloudflare") return raw;
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

export function tunnelInvokeArgs(): { provider: TunnelProviderId; ngrokAuthToken: string } {
  return {
    provider: loadTunnelProvider(),
    ngrokAuthToken: loadNgrokAuthToken(),
  };
}

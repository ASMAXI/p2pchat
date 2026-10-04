import { normalizeOrigin } from "@workspace/p2p-protocol";

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

/** Loopback + RFC1918 — unreachable for friends outside the host's LAN/VPN. */
export function isPrivateOrLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host.startsWith("192.168.") ||
    host.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  );
}

/** Prefer public/tunnel URL, then LAN, never put loopback first for invites. */
export function orderInviteOrigins(origins: string[]): string[] {
  const unique = origins
    .map(normalizeOrigin)
    .filter(Boolean)
    .filter((origin, index, list) => list.indexOf(origin) === index);
  const publicOnes = unique.filter((origin) => {
    try {
      return !isPrivateOrLoopbackHost(new URL(origin).hostname);
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
 * Origins for a shareable invite link.
 * If any public/tunnel URL exists, omit LAN/VPN (10.x / 192.168 / 172.16-31) —
 * friends outside can't reach them and dead VPN hops stall join.
 * LAN-only parties still get private non-loopback origins.
 */
export function filterShareableInviteOrigins(origins: string[]): string[] {
  const ordered = orderInviteOrigins(origins);
  const publicOnes = ordered.filter((origin) => {
    try {
      return !isPrivateOrLoopbackHost(new URL(origin).hostname);
    } catch {
      return false;
    }
  });
  if (publicOnes.length > 0) return publicOnes;
  return ordered.filter((origin) => {
    try {
      const host = new URL(origin).hostname;
      return host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]";
    } catch {
      return false;
    }
  });
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
      else if (isPrivateOrLoopbackHost(host)) lan.push(origin);
      else publicOnes.push(origin);
    } catch {
      publicOnes.push(origin);
    }
  }
  return [...lan, ...publicOnes, ...loopback];
}

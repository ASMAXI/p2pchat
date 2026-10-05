import type { WireRoomState } from "@workspace/p2p-protocol";

export type ConnectTarget = {
  origin: string;
  /** Connect to our own node and act as coordinator. */
  host: boolean;
  peerId?: string;
};

export type ConnectPlanInput = {
  state: WireRoomState | null;
  selfId: string;
  localOrigin?: string;
  /** Origins that belong to this device — never used as remote join targets. */
  selfOrigins?: string[];
  bootstrapOrigins: string[];
  /** Coordinator that just became unreachable; excluded from the candidate list. */
  failedHostId?: string | null;
  /** Origin of the connection that just ended, retried once before migrating. */
  retryOrigin?: string;
  redirect?: string[];
  /** First connection after launch: prefer joining an existing coordinator over self-hosting. */
  startup: boolean;
  /** When false, never take over as coordinator (tests / constrained clients without a hub). */
  allowSelfHost?: boolean;
  /**
   * When true, keep 127.0.0.1/localhost bootstrap targets (local multi-node E2E).
   * Production stays false: invite loopback points at the joiner's machine, not the host.
   */
  allowLoopbackBootstrap?: boolean;
};

function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

function isLanOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return (
      host.startsWith("192.168.") ||
      host.startsWith("10.") ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    );
  } catch {
    return false;
  }
}

/** Reachable from the public internet (tunnel / public DNS), not LAN or loopback. */
export function isPublicEndpoint(origin: string): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return !isLoopbackOrigin(origin) && !isLanOrigin(origin);
  } catch {
    return false;
  }
}

function normalizeForCompare(origin: string): string {
  return origin.trim().replace(/\/$/, "");
}

/** Public/tunnel URLs first, then LAN, then loopback — so internet peers reach the successor. */
export function preferReachableEndpoints(endpoints: string[]): string[] {
  const unique = endpoints.filter((origin, index, list) => origin && list.indexOf(origin) === index);
  const score = (origin: string) => {
    if (isLoopbackOrigin(origin)) return 2;
    if (isLanOrigin(origin)) return 1;
    return 0;
  };
  return [...unique].sort((left, right) => score(left) - score(right));
}

export function peerHasPublicEndpoint(endpoints: string[]): boolean {
  return endpoints.some((origin) => isPublicEndpoint(origin));
}

/**
 * Peers that may take over the coordinator role, in deterministic order. Every peer computes
 * the same list from the same replicated state, so they converge on the same successor.
 *
 * Prefer peers that advertised a public/tunnel URL, then break ties by peerId. Pure LAN
 * parties (no public endpoints anywhere) still fall back to lexicographic peerId order.
 *
 * After an abrupt host death the replica still marks everyone "online", but a stale offline
 * flag must not hide a desktop peer that advertised endpoints — otherwise failover has nobody
 * to dial and friends need a fresh invite.
 */
export function migrationCandidates(
  state: WireRoomState,
  failedHostId: string | null | undefined,
  selfId: string,
  selfCanHost: boolean,
): Array<{ peerId: string; endpoints: string[] }> {
  return state.members
    .filter((member) => member.id !== failedHostId)
    .filter((member) =>
      member.id === selfId ? selfCanHost : (member.endpoints?.length ?? 0) > 0,
    )
    .map((member) => ({
      peerId: member.id,
      endpoints: preferReachableEndpoints(member.endpoints ?? []),
    }))
    .sort((left, right) => {
      const leftPublic = peerHasPublicEndpoint(left.endpoints) ? 0 : 1;
      const rightPublic = peerHasPublicEndpoint(right.endpoints) ? 0 : 1;
      if (leftPublic !== rightPublic) return leftPublic - rightPublic;
      return left.peerId < right.peerId ? -1 : left.peerId > right.peerId ? 1 : 0;
    });
}

export function buildConnectPlan(input: ConnectPlanInput): ConnectTarget[] {
  const { state, selfId, localOrigin } = input;
  const allowSelfHost = input.allowSelfHost !== false;
  const canHost = Boolean(allowSelfHost && localOrigin && state);
  const selfOrigins = new Set(
    [localOrigin, ...(input.selfOrigins ?? [])]
      .filter(Boolean)
      .map((origin) => normalizeForCompare(origin!)),
  );
  const targets: ConnectTarget[] = [];
  const add = (target: ConnectTarget) => {
    if (!target.origin) return;
    const normalized = normalizeForCompare(target.origin);
    // Never "join" ourselves as a remote peer — that creates a false local takeover path.
    if (!target.host && selfOrigins.has(normalized)) return;
    if (!target.host && target.origin === localOrigin) return;
    if (targets.some((item) => item.origin === target.origin && item.host === target.host)) return;
    targets.push(target);
  };
  const addPeer = (peerId: string, endpoints: string[]) => {
    if (peerId === selfId) {
      if (canHost) add({ origin: localOrigin!, host: true, peerId });
      return;
    }
    for (const origin of preferReachableEndpoints(endpoints)) add({ origin, host: false, peerId });
  };

  for (const origin of input.redirect ?? []) add({ origin, host: origin === localOrigin });
  if (input.retryOrigin) add({ origin: input.retryOrigin, host: input.retryOrigin === localOrigin });

  if (state) {
    if (input.startup) {
      const host = state.members.find((member) => member.id === state.hostId);
      if (host && host.id !== selfId) addPeer(host.id, host.endpoints ?? []);
      for (const member of [...state.members].sort((left, right) => (left.id < right.id ? -1 : 1))) {
        if (member.id !== selfId) addPeer(member.id, member.endpoints ?? []);
      }
    } else {
      for (const candidate of migrationCandidates(state, input.failedHostId, selfId, canHost)) {
        addPeer(candidate.peerId, candidate.endpoints);
      }
    }
  }

  for (const origin of input.bootstrapOrigins) {
    // Loopback in an invite is almost never useful for friends; skip unless hosting locally
    // or explicitly allowed (same-machine multi-node tests on different 127.0.0.1 ports).
    if (
      isLoopbackOrigin(origin) &&
      !input.allowLoopbackBootstrap &&
      !targetIsLocalHostIntent(origin, localOrigin)
    ) {
      continue;
    }
    add({ origin, host: false });
  }
  if (canHost) add({ origin: localOrigin!, host: true, peerId: selfId });
  return targets;
}

function targetIsLocalHostIntent(origin: string, localOrigin?: string): boolean {
  return Boolean(localOrigin && normalizeForCompare(origin) === normalizeForCompare(localOrigin));
}

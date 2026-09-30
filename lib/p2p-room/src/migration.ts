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
  bootstrapOrigins: string[];
  /** Coordinator that just became unreachable; excluded from the candidate list. */
  failedHostId?: string | null;
  /** Origin of the connection that just ended, retried once before migrating. */
  retryOrigin?: string;
  redirect?: string[];
  /** First connection after launch: prefer joining an existing coordinator over self-hosting. */
  startup: boolean;
};

/**
 * Peers that may take over the coordinator role, in deterministic order. Every peer computes
 * the same list from the same replicated state, so they converge on the same successor.
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
      member.id === selfId ? selfCanHost : member.online && (member.endpoints?.length ?? 0) > 0,
    )
    .map((member) => ({ peerId: member.id, endpoints: member.endpoints ?? [] }))
    .sort((left, right) => (left.peerId < right.peerId ? -1 : left.peerId > right.peerId ? 1 : 0));
}

export function buildConnectPlan(input: ConnectPlanInput): ConnectTarget[] {
  const { state, selfId, localOrigin } = input;
  const canHost = Boolean(localOrigin && state);
  const targets: ConnectTarget[] = [];
  const add = (target: ConnectTarget) => {
    if (!target.origin) return;
    if (!target.host && target.origin === localOrigin) return;
    if (targets.some((item) => item.origin === target.origin && item.host === target.host)) return;
    targets.push(target);
  };
  const addPeer = (peerId: string, endpoints: string[]) => {
    if (peerId === selfId) {
      if (canHost) add({ origin: localOrigin!, host: true, peerId });
      return;
    }
    for (const origin of endpoints) add({ origin, host: false, peerId });
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

  for (const origin of input.bootstrapOrigins) add({ origin, host: false });
  if (canHost) add({ origin: localOrigin!, host: true, peerId: selfId });
  return targets;
}

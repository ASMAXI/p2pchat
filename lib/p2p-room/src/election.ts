export type CoordinatorClaim = {
  epoch: number;
  hostId: string;
  alwaysHost?: boolean;
};

/**
 * Total order over coordinator claims, used to resolve split-brain: an always-on bootstrap
 * node wins, then the higher epoch, then the lexicographically smaller host id.
 * Returns a positive number when `left` wins.
 */
export function compareCoordinators(left: CoordinatorClaim, right: CoordinatorClaim): number {
  if (Boolean(left.alwaysHost) !== Boolean(right.alwaysHost)) return left.alwaysHost ? 1 : -1;
  if (left.epoch !== right.epoch) return left.epoch - right.epoch;
  if (left.hostId === right.hostId) return 0;
  return left.hostId < right.hostId ? 1 : -1;
}

/** Deterministic pick among connected peers (used by always-on bootstrap nodes). */
export function electCoordinator(onlinePeerIds: string[]): string | null {
  const sorted = [...onlinePeerIds].sort();
  return sorted[0] ?? null;
}

export function isStaleEpoch(incomingEpoch: number, authoritativeEpoch: number): boolean {
  return incomingEpoch < authoritativeEpoch;
}

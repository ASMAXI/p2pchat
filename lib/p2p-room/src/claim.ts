import { signText, verifyPeerSignature, type StoredIdentity } from "@workspace/p2p-identity";
import {
  claimProofText,
  isSignedCoordinatorClaim,
  LIMITS,
  type SignedCoordinatorClaim,
  type WireRoomState,
} from "@workspace/p2p-protocol";

/** Epoch / previousHostId a peer should advertise when becoming coordinator. */
export function proposedCoordinatorClaimFields(
  state: WireRoomState | null | undefined,
  selfId: string,
): { epoch: number; previousHostId: string | null } {
  if (!state) return { epoch: 1, previousHostId: null };
  const previousHostId = state.epoch > 0 && state.hostId !== selfId ? state.hostId : null;
  // Matches legacy hub behaviour: every fresh host session advances epoch
  // (including reclaim after the previous host socket cleared hostPeerId).
  return { epoch: state.epoch + 1, previousHostId };
}

export function createSignedCoordinatorClaim(
  identity: StoredIdentity,
  fields: { roomId: string; epoch: number; previousHostId: string | null; ts?: number },
): SignedCoordinatorClaim {
  const ts = fields.ts ?? Date.now();
  const unsigned = {
    roomId: fields.roomId,
    epoch: fields.epoch,
    hostId: identity.peerId,
    previousHostId: fields.previousHostId,
    publicKey: identity.publicKey,
    ts,
  };
  return {
    ...unsigned,
    signature: signText(identity, claimProofText(unsigned)),
  };
}

/**
 * Structural + crypto checks for a host-join claim.
 * Returns an error message, or null when the claim is acceptable for the room.
 */
export function verifyCoordinatorClaimForJoin(
  claim: unknown,
  context: {
    roomId: string;
    peerId: string;
    publicKey: string;
    roomEpoch: number;
    roomHostId: string;
    now?: number;
  },
): string | null {
  if (!isSignedCoordinatorClaim(claim)) return "Некорректный coordinator claim";
  if (claim.roomId !== context.roomId) return "Claim относится к другой комнате";
  if (claim.hostId !== context.peerId) return "Claim hostId не совпадает с участником";
  if (claim.publicKey !== context.publicKey) return "Claim publicKey не совпадает с участником";
  const now = context.now ?? Date.now();
  if (Math.abs(now - claim.ts) > LIMITS.joinClockSkewMs) {
    return "Проверьте системное время на компьютере";
  }
  if (claim.epoch < context.roomEpoch) return "Устаревший coordinator claim";
  if (claim.epoch === context.roomEpoch) {
    // Same-epoch re-assert: only the live host may keep the epoch.
    if (context.roomEpoch > 0 && claim.hostId !== context.roomHostId) {
      return "Конфликт coordinator claim";
    }
  }
  if (
    !verifyPeerSignature(claim.hostId, claim.publicKey, claimProofText(claim), claim.signature)
  ) {
    return "Подпись coordinator claim недействительна";
  }
  return null;
}

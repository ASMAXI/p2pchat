import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createIdentity } from "@workspace/p2p-identity";
import { claimProofText, createInitialRoomState, isSignedCoordinatorClaim } from "@workspace/p2p-protocol";
import {
  createSignedCoordinatorClaim,
  proposedCoordinatorClaimFields,
  verifyCoordinatorClaimForJoin,
} from "./claim";

describe("coordinator claim", () => {
  it("signs and verifies a host succession claim", () => {
    const identity = createIdentity("Host");
    const claim = createSignedCoordinatorClaim(identity, {
      roomId: "room-1",
      epoch: 3,
      previousHostId: "prev-host",
      ts: Date.now(),
    });
    assert.equal(isSignedCoordinatorClaim(claim), true);
    assert.match(claimProofText(claim), /\/claim\/room-1\/3\/.+\/prev-host\//);
    assert.equal(
      verifyCoordinatorClaimForJoin(claim, {
        roomId: "room-1",
        peerId: identity.peerId,
        publicKey: identity.publicKey,
        roomEpoch: 2,
        roomHostId: "prev-host",
      }),
      null,
    );
  });

  it("rejects forged signatures and stale epochs", () => {
    const host = createIdentity("Host");
    const attacker = createIdentity("Attacker");
    const claim = createSignedCoordinatorClaim(host, {
      roomId: "room-1",
      epoch: 2,
      previousHostId: null,
    });
    const forged = { ...claim, signature: createSignedCoordinatorClaim(attacker, {
      roomId: "room-1",
      epoch: 2,
      previousHostId: null,
    }).signature };
    assert.match(
      verifyCoordinatorClaimForJoin(forged, {
        roomId: "room-1",
        peerId: host.peerId,
        publicKey: host.publicKey,
        roomEpoch: 1,
        roomHostId: "other",
      }) ?? "",
      /подпись/i,
    );

    const stale = createSignedCoordinatorClaim(host, {
      roomId: "room-1",
      epoch: 1,
      previousHostId: null,
    });
    assert.match(
      verifyCoordinatorClaimForJoin(stale, {
        roomId: "room-1",
        peerId: host.peerId,
        publicKey: host.publicKey,
        roomEpoch: 5,
        roomHostId: "other",
      }) ?? "",
      /устаревш/i,
    );
  });

  it("proposes epoch+1 and previousHostId on takeover", () => {
    const a = createIdentity("A");
    const b = createIdentity("B");
    const state = createInitialRoomState({
      roomId: "r",
      name: "room",
      ownerId: a.peerId,
      ownerName: a.displayName,
      ownerPublicKey: a.publicKey,
      endpoints: [],
    });
    assert.deepEqual(proposedCoordinatorClaimFields(state, a.peerId), {
      epoch: 1,
      previousHostId: null,
    });
    state.epoch = 4;
    state.hostId = a.peerId;
    assert.deepEqual(proposedCoordinatorClaimFields(state, b.peerId), {
      epoch: 5,
      previousHostId: a.peerId,
    });
    assert.deepEqual(proposedCoordinatorClaimFields(state, a.peerId), {
      epoch: 5,
      previousHostId: null,
    });
  });

  it("allows same-epoch re-assert only for the live host", () => {
    const host = createIdentity("Host");
    const other = createIdentity("Other");
    const claim = createSignedCoordinatorClaim(host, {
      roomId: "room-1",
      epoch: 4,
      previousHostId: null,
    });
    assert.equal(
      verifyCoordinatorClaimForJoin(claim, {
        roomId: "room-1",
        peerId: host.peerId,
        publicKey: host.publicKey,
        roomEpoch: 4,
        roomHostId: host.peerId,
      }),
      null,
    );
    const hijack = createSignedCoordinatorClaim(other, {
      roomId: "room-1",
      epoch: 4,
      previousHostId: host.peerId,
    });
    assert.match(
      verifyCoordinatorClaimForJoin(hijack, {
        roomId: "room-1",
        peerId: other.peerId,
        publicKey: other.publicKey,
        roomEpoch: 4,
        roomHostId: host.peerId,
      }) ?? "",
      /конфликт/i,
    );
  });
});

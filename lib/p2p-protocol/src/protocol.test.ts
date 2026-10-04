import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildInvite, buildInviteDeepLink, claimProofText, isSignedCoordinatorClaim, parseInvite, validateVoiceSignalData } from "./index";
import { loadTestdata } from "./test-fixtures";

describe("invite", () => {
  it("round-trips via HTTPS landing (Steam-friendly) and deep link", () => {
    const fields = {
      roomId: "r1",
      inviteToken: "t/+=",
      roomKey: "k",
      origins: ["http://192.168.1.5:47821/", "http://10.0.0.2:47821/api"],
    };
    const httpsInvite = buildInvite(fields);
    assert.match(httpsInvite, /^https:\/\/asmaxi\.github\.io\/p2pchat\/join\//);
    assert.match(httpsInvite, /[?&]d=/);
    assert.deepEqual(parseInvite(httpsInvite), {
      roomId: "r1",
      inviteToken: "t/+=",
      roomKey: "k",
      origins: ["http://192.168.1.5:47821", "http://10.0.0.2:47821"],
    });

    const deep = buildInviteDeepLink(fields);
    assert.match(deep, /^drift:\/\/j\/[A-Za-z0-9_-]+$/);
    assert.deepEqual(parseInvite(deep), {
      roomId: "r1",
      inviteToken: "t/+=",
      roomKey: "k",
      origins: ["http://192.168.1.5:47821", "http://10.0.0.2:47821"],
    });
  });

  it("still parses legacy p2pchat query invites", () => {
    const legacy =
      "p2pchat://join?room=r1&token=t%2F%2B%3D&key=k&api=http%3A%2F%2F192.168.1.5%3A47821%2F&api=http%3A%2F%2F10.0.0.2%3A47821%2Fapi";
    assert.deepEqual(parseInvite(legacy), {
      roomId: "r1",
      inviteToken: "t/+=",
      roomKey: "k",
      origins: ["http://192.168.1.5:47821", "http://10.0.0.2:47821"],
    });
  });

  it("never carries private identity material", () => {
    const invite = buildInvite({ roomId: "r", inviteToken: "t", origins: [] });
    assert.doesNotMatch(invite, /private/i);
  });

  it("rejects incomplete invites", () => {
    assert.equal(parseInvite("p2pchat://join?room=r1"), null);
    assert.equal(parseInvite("drift://j/"), null);
    assert.equal(parseInvite(""), null);
  });
});

describe("voice signal validation", () => {
  it("accepts known small WebRTC signal kinds from fixtures including screen-share", () => {
    const fixture = loadTestdata<{
      validSignals: unknown[];
      invalidKinds: string[];
    }>("voice-signals.json");
    for (const signal of fixture.validSignals) {
      assert.equal(validateVoiceSignalData(signal), null, JSON.stringify(signal));
    }
    for (const kind of fixture.invalidKinds) {
      assert.match(validateVoiceSignalData({ kind }) ?? "", /kind/i, kind);
    }
  });

  it("rejects non-objects and oversized payloads", () => {
    assert.match(validateVoiceSignalData("nope") ?? "", /объект/i);
    const huge = { kind: "offer", pad: "x".repeat(70_000) };
    assert.match(validateVoiceSignalData(huge) ?? "", /большой/i);
  });
});

describe("coordinator claim shape", () => {
  it("accepts a well-formed claim and builds a stable proof text", () => {
    const claim = {
      roomId: "r1",
      epoch: 2,
      hostId: "host",
      previousHostId: null as string | null,
      publicKey: "abc",
      ts: 1,
      signature: "sig",
    };
    assert.equal(isSignedCoordinatorClaim(claim), true);
    assert.equal(claimProofText(claim), "p2pchat/v1/claim/r1/2/host/-/1");
    assert.equal(
      claimProofText({ ...claim, previousHostId: "prev" }),
      "p2pchat/v1/claim/r1/2/host/prev/1",
    );
  });

  it("rejects incomplete claims", () => {
    assert.equal(isSignedCoordinatorClaim({ roomId: "r", epoch: 0, hostId: "h" }), false);
    assert.equal(isSignedCoordinatorClaim(null), false);
  });
});

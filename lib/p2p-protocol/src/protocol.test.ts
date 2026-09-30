import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildInvite, parseInvite } from "./index";

describe("invite", () => {
  it("round-trips room, token, key and several endpoints", () => {
    const invite = buildInvite({
      roomId: "r1",
      inviteToken: "t/+=",
      roomKey: "k",
      origins: ["http://192.168.1.5:47821/", "http://10.0.0.2:47821/api"],
    });
    assert.deepEqual(parseInvite(invite), {
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
    assert.equal(parseInvite(""), null);
  });
});

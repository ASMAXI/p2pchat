import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildInvite, buildInviteDeepLink, parseInvite } from "./index";

describe("invite", () => {
  it("round-trips via HTTPS landing (Steam-friendly) and deep link", () => {
    const fields = {
      roomId: "r1",
      inviteToken: "t/+=",
      roomKey: "k",
      origins: ["http://192.168.1.5:47821/", "http://10.0.0.2:47821/api"],
    };
    const httpsInvite = buildInvite(fields);
    assert.match(httpsInvite, /^https:\/\//);
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

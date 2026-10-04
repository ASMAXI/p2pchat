import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  filterShareableInviteOrigins,
  isPrivateOrLoopbackHost,
  orderInviteOrigins,
} from "./invite-origins";
import { loadTestdata } from "./test-fixtures";

type InviteFixture = {
  privateHosts: string[];
  publicHosts: string[];
  shareableCases: Array<{ name: string; input: string[]; expected: string[] }>;
};

describe("shareable invite origins", () => {
  const fixture = loadTestdata<InviteFixture>("invite-origins.json");

  it("detects RFC1918 and loopback hosts from fixtures", () => {
    for (const host of fixture.privateHosts) {
      assert.equal(isPrivateOrLoopbackHost(host), true, host);
    }
    for (const host of fixture.publicHosts) {
      assert.equal(isPrivateOrLoopbackHost(host), false, host);
    }
  });

  for (const shareCase of fixture.shareableCases) {
    it(shareCase.name, () => {
      assert.deepEqual(filterShareableInviteOrigins(shareCase.input), shareCase.expected);
    });
  }

  it("orders public before LAN without removing either", () => {
    const ordered = orderInviteOrigins([
      "http://10.122.3.68:47821",
      "https://abc.trycloudflare.com",
    ]);
    assert.equal(ordered[0], "https://abc.trycloudflare.com");
    assert.ok(ordered.includes("http://10.122.3.68:47821"));
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  filterShareableInviteOrigins,
  isPrivateOrLoopbackHost,
  orderInviteOrigins,
} from "./invite-origins";

describe("shareable invite origins", () => {
  it("detects RFC1918 and loopback hosts", () => {
    assert.equal(isPrivateOrLoopbackHost("10.122.3.68"), true);
    assert.equal(isPrivateOrLoopbackHost("192.168.1.5"), true);
    assert.equal(isPrivateOrLoopbackHost("172.16.0.1"), true);
    assert.equal(isPrivateOrLoopbackHost("127.0.0.1"), true);
    assert.equal(isPrivateOrLoopbackHost("abc.trycloudflare.com"), false);
  });

  it("drops VPN/LAN from invite when a public tunnel exists", () => {
    const origins = filterShareableInviteOrigins([
      "http://10.122.3.68:47821",
      "https://abc.trycloudflare.com",
      "http://192.168.1.10:47821",
    ]);
    assert.deepEqual(origins, ["https://abc.trycloudflare.com"]);
  });

  it("keeps LAN when there is no public URL (LAN-only party)", () => {
    const origins = filterShareableInviteOrigins([
      "http://192.168.1.10:47821",
      "http://10.0.0.2:47821",
      "http://127.0.0.1:47821",
    ]);
    assert.deepEqual(origins, ["http://192.168.1.10:47821", "http://10.0.0.2:47821"]);
  });

  it("orders public before LAN without removing either", () => {
    const ordered = orderInviteOrigins([
      "http://10.122.3.68:47821",
      "https://abc.trycloudflare.com",
    ]);
    assert.equal(ordered[0], "https://abc.trycloudflare.com");
    assert.ok(ordered.includes("http://10.122.3.68:47821"));
  });
});

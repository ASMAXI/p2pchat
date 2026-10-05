import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WireRoomState } from "@workspace/p2p-protocol";
import { buildConnectPlan, migrationCandidates } from "./migration";
import { loadTestdata } from "./test-fixtures";

const state = loadTestdata<WireRoomState>("room-state-migration.json");

describe("migration", () => {
  it("orders successors deterministically and skips the failed host and web peers without endpoints", () => {
    const candidates = migrationCandidates(state, "a", "c", true).map((item) => item.peerId);
    // Offline peer "d" still has endpoints — keep it for abrupt-host failover.
    assert.deepEqual(candidates, ["b", "c", "d"]);
  });

  it("keeps offline desktop peers with endpoints as failover targets", () => {
    const withOffline: WireRoomState = {
      ...state,
      members: [
        { id: "a", name: "A", role: "owner", joinedAt: "", online: false, endpoints: ["http://a"] },
        { id: "b", name: "B", role: "member", joinedAt: "", online: false, endpoints: ["http://b"] },
        { id: "c", name: "C", role: "member", joinedAt: "", online: true, endpoints: ["http://c"] },
        { id: "w", name: "Web", role: "member", joinedAt: "", online: true, endpoints: [] },
      ],
    };
    const candidates = migrationCandidates(withOffline, "a", "c", true).map((item) => item.peerId);
    assert.deepEqual(candidates, ["b", "c"]);
  });

  it("makes the first successor host itself and others connect to it", () => {
    const forB = buildConnectPlan({
      state,
      selfId: "b",
      localOrigin: "http://127.0.0.1:1",
      bootstrapOrigins: [],
      failedHostId: "a",
      startup: false,
    });
    assert.deepEqual(forB[0], { origin: "http://127.0.0.1:1", host: true, peerId: "b" });

    const forC = buildConnectPlan({
      state,
      selfId: "c",
      localOrigin: "http://127.0.0.1:2",
      bootstrapOrigins: [],
      failedHostId: "a",
      startup: false,
    });
    assert.deepEqual(forC.map((target) => target.origin), ["http://b", "http://127.0.0.1:2", "http://d"]);
  });

  it("prefers joining an existing coordinator over self-hosting after a restart", () => {
    const plan = buildConnectPlan({
      state,
      selfId: "a",
      localOrigin: "http://127.0.0.1:1",
      bootstrapOrigins: [],
      startup: true,
    });
    assert.equal(plan.at(-1)?.host, true);
    assert.ok(plan.slice(0, -1).every((target) => !target.host));
  });

  it("never self-hosts without a replica of the room", () => {
    const plan = buildConnectPlan({
      state: null,
      selfId: "x",
      localOrigin: "http://127.0.0.1:1",
      bootstrapOrigins: ["http://invite"],
      startup: true,
    });
    assert.deepEqual(plan, [{ origin: "http://invite", host: false }]);
  });

  it("prefers public successor endpoints before LAN/loopback after host failure", () => {
    const withPublic: WireRoomState = {
      ...state,
      members: [
        { id: "a", name: "A", role: "owner", joinedAt: "", online: true, endpoints: ["http://a"] },
        {
          id: "b",
          name: "B",
          role: "member",
          joinedAt: "",
          online: true,
          endpoints: ["http://127.0.0.1:9", "http://192.168.1.5:9", "https://b.ngrok-free.app"],
        },
        { id: "c", name: "C", role: "member", joinedAt: "", online: true, endpoints: ["http://c"] },
      ],
    };
    const forC = buildConnectPlan({
      state: withPublic,
      selfId: "c",
      localOrigin: "http://127.0.0.1:2",
      bootstrapOrigins: [],
      failedHostId: "a",
      startup: false,
    });
    assert.equal(forC[0]?.peerId, "b");
    assert.equal(forC[0]?.origin, "https://b.ngrok-free.app");
    assert.deepEqual(
      forC.filter((target) => target.peerId === "b").map((target) => target.origin),
      ["https://b.ngrok-free.app", "http://192.168.1.5:9", "http://127.0.0.1:9"],
    );
  });

  it("elects a public-tunnel peer over a lexicographically earlier LAN-only peer", () => {
    const mixed: WireRoomState = {
      ...state,
      members: [
        { id: "a", name: "A", role: "owner", joinedAt: "", online: true, endpoints: ["https://a.trycloudflare.com"] },
        {
          id: "b",
          name: "B",
          role: "member",
          joinedAt: "",
          online: true,
          endpoints: ["http://192.168.0.10:47821", "http://127.0.0.1:47821"],
        },
        {
          id: "z",
          name: "Z",
          role: "member",
          joinedAt: "",
          online: true,
          endpoints: ["https://z.trycloudflare.com", "http://192.168.0.99:47821"],
        },
      ],
    };
    assert.deepEqual(
      migrationCandidates(mixed, "a", "b", true).map((item) => item.peerId),
      ["z", "b"],
    );

    const forB = buildConnectPlan({
      state: mixed,
      selfId: "b",
      localOrigin: "http://127.0.0.1:47821",
      bootstrapOrigins: [],
      failedHostId: "a",
      startup: false,
    });
    assert.equal(forB[0]?.peerId, "z");
    assert.equal(forB[0]?.origin, "https://z.trycloudflare.com");
    assert.equal(forB[0]?.host, false);
    assert.ok(forB.some((target) => target.host && target.peerId === "b"));
  });

  it("never joins its own LAN/public endpoints as a remote peer", () => {
    const plan = buildConnectPlan({
      state: null,
      selfId: "a",
      localOrigin: "http://127.0.0.1:47821",
      selfOrigins: ["http://127.0.0.1:47821", "http://192.168.0.14:47821", "https://mine.trycloudflare.com"],
      bootstrapOrigins: [
        "http://192.168.0.14:47821",
        "https://mine.trycloudflare.com",
        "https://friend.trycloudflare.com",
        "http://127.0.0.1:5000",
      ],
      startup: true,
      allowSelfHost: false,
    });
    assert.deepEqual(plan, [{ origin: "https://friend.trycloudflare.com", host: false }]);
  });

  it("refuses self-host when allowSelfHost is false even with a replica", () => {
    const plan = buildConnectPlan({
      state,
      selfId: "a",
      localOrigin: "http://127.0.0.1:1",
      bootstrapOrigins: ["http://invite"],
      startup: true,
      allowSelfHost: false,
    });
    assert.ok(plan.every((target) => !target.host));
    assert.ok(plan.some((target) => target.origin === "http://invite"));
  });
});

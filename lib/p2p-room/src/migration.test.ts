import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WireRoomState } from "@workspace/p2p-protocol";
import { buildConnectPlan, migrationCandidates } from "./migration";

const state: WireRoomState = {
  id: "room",
  name: "Room",
  ownerId: "a",
  hostId: "a",
  hostName: "A",
  epoch: 3,
  channels: [],
  messages: [],
  voiceParticipants: {},
  members: [
    { id: "a", name: "A", role: "owner", joinedAt: "", online: true, endpoints: ["http://a"] },
    { id: "c", name: "C", role: "member", joinedAt: "", online: true, endpoints: ["http://c"] },
    { id: "b", name: "B", role: "member", joinedAt: "", online: true, endpoints: ["http://b"] },
    { id: "d", name: "D", role: "member", joinedAt: "", online: false, endpoints: ["http://d"] },
    { id: "w", name: "Web", role: "member", joinedAt: "", online: true },
  ],
};

describe("migration", () => {
  it("orders successors deterministically and skips the failed host, offline and web peers", () => {
    const candidates = migrationCandidates(state, "a", "c", true).map((item) => item.peerId);
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
    assert.deepEqual(forC.map((target) => target.origin), ["http://b", "http://127.0.0.1:2"]);
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
});

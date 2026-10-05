import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInitialRoomState, type WireMessage } from "@workspace/p2p-protocol";
import {
  appendChannelEvent,
  appendCoordinatorEvent,
  appendMessageEvent,
  foldRoomState,
  materializeRoomState,
  mergeEventLogs,
  seedEventsFromSnapshot,
} from "./room-events";

const base = createInitialRoomState({
  roomId: "r1",
  name: "Test",
  ownerId: "owner",
  ownerName: "Owner",
  ownerPublicKey: "pk",
  endpoints: ["http://127.0.0.1:1"],
});

function msg(id: string): WireMessage {
  return {
    id,
    channelId: "general",
    authorId: "owner",
    author: "Owner",
    authorPublicKey: "pk",
    content: "e1.aa.bb",
    timestamp: `2026-01-01T00:00:0${id.slice(-1)}.000Z`,
    signature: "sig",
  };
}

describe("room events", () => {
  it("seeds a legacy snapshot into an ordered event log", () => {
    const withMsg = { ...base, messages: [msg("m1")], epoch: 2 };
    const events = seedEventsFromSnapshot(withMsg);
    assert.ok(events.some((event) => event.kind === "channel_create"));
    assert.ok(events.some((event) => event.kind === "coordinator_takeover" && event.epoch === 2));
    assert.ok(events.some((event) => event.kind === "message" && event.message.id === "m1"));
    assert.equal(events[0]?.predecessorId, undefined);
    assert.equal(events[1]?.predecessorId, events[0]?.eventId);
  });

  it("folds events as source of truth for messages and epoch", () => {
    let state = materializeRoomState(base);
    state = appendMessageEvent(state, msg("m1"));
    state = appendCoordinatorEvent(state, {
      hostId: "b",
      hostName: "B",
      epoch: 3,
      previousHostId: "owner",
    });
    state = appendMessageEvent(state, msg("m2"));
    const folded = foldRoomState(base, state.events ?? []);
    assert.deepEqual(
      folded.messages.map((item) => item.id),
      ["m1", "m2"],
    );
    assert.equal(folded.epoch, 3);
    assert.equal(folded.hostId, "b");
  });

  it("merges concurrent logs by eventId without duplicates", () => {
    const left = appendMessageEvent(materializeRoomState(base), msg("m1"));
    const right = appendChannelEvent(materializeRoomState(base), {
      id: "extra",
      name: "extra",
      type: "text",
      unreadCount: 0,
      members: 0,
    });
    const merged = mergeEventLogs(left.events, right.events);
    assert.equal(new Set(merged.map((event) => event.eventId)).size, merged.length);
    assert.ok(merged.some((event) => event.kind === "message"));
    assert.ok(merged.some((event) => event.kind === "channel_create" && event.channel.id === "extra"));
  });

  it("keeps snapshot channels when the event log only has later creates", () => {
    const lateOnly = [
      {
        kind: "channel_create" as const,
        eventId: "e-late",
        sequence: 1,
        ts: "2026-01-01T00:00:00.000Z",
        channel: {
          id: "channel-extra",
          name: "новый",
          type: "text" as const,
          unreadCount: 0,
          members: 0,
        },
      },
    ];
    const folded = foldRoomState(base, lateOnly);
    assert.ok(folded.channels.some((channel) => channel.id === "general"));
    assert.ok(folded.channels.some((channel) => channel.id === "lounge"));
    assert.ok(folded.channels.some((channel) => channel.id === "channel-extra"));
  });
});

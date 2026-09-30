import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventLog, type OrderedEvent } from "./event-log";

const event = (eventId: string, sequence: number, predecessorId?: string): OrderedEvent => ({
  eventId,
  sequence,
  predecessorId,
});

describe("event log", () => {
  it("deduplicates by eventId", () => {
    const log = new EventLog();
    assert.equal(log.stage(event("e-1", 1)), "applied");
    assert.equal(log.stage(event("e-1", 1)), "duplicate");
    assert.equal(log.listApplied().length, 1);
  });

  it("buffers out-of-order events until the predecessor arrives", () => {
    const log = new EventLog();
    assert.equal(log.stage(event("e-3", 3, "e-2")), "pending");
    assert.equal(log.stage(event("e-2", 2, "e-1")), "pending");
    assert.equal(log.stage(event("e-1", 1)), "applied");
    assert.deepEqual(log.listApplied().map((item) => item.eventId), ["e-1", "e-2", "e-3"]);
    assert.equal(log.pendingCount(), 0);
  });

  it("bounds the pending buffer", () => {
    const log = new EventLog(2);
    log.stage(event("a", 2, "x"));
    log.stage(event("b", 3, "x"));
    log.stage(event("c", 4, "x"));
    assert.equal(log.pendingCount(), 2);
  });
});

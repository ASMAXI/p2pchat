import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareCoordinators, electCoordinator, isStaleEpoch } from "./election";

describe("coordinator election", () => {
  it("picks the lexicographically smallest online peer", () => {
    assert.equal(electCoordinator(["peer-b", "peer-a", "peer-c"]), "peer-a");
    assert.equal(electCoordinator([]), null);
  });

  it("orders competing coordinators by epoch, then by host id", () => {
    assert.ok(compareCoordinators({ epoch: 5, hostId: "z" }, { epoch: 4, hostId: "a" }) > 0);
    assert.ok(compareCoordinators({ epoch: 4, hostId: "a" }, { epoch: 4, hostId: "b" }) > 0);
    assert.ok(compareCoordinators({ epoch: 1, hostId: "z", alwaysHost: true }, { epoch: 9, hostId: "a" }) > 0);
    assert.equal(compareCoordinators({ epoch: 2, hostId: "a" }, { epoch: 2, hostId: "a" }), 0);
  });

  it("detects stale epochs", () => {
    assert.equal(isStaleEpoch(4, 5), true);
    assert.equal(isStaleEpoch(5, 5), false);
  });
});

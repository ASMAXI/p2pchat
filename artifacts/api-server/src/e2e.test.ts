import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  createIdentity,
  generateRoomKey,
  randomToken,
  signText,
  type StoredIdentity,
} from "@workspace/p2p-identity";
import {
  createInitialRoomState,
  joinProofText,
  PROTOCOL_VERSION,
  type ServerEvent,
} from "@workspace/p2p-protocol";
import { RoomSession, type SessionSnapshot, type SessionView } from "@workspace/p2p-room";
import { createSyncServer, type SyncServer } from "./server";

const workDir = mkdtempSync(join(tmpdir(), "p2pchat-e2e-"));
const cleanups: Array<() => unknown> = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // SQLite WAL files can stay locked briefly on Windows.
  }
});

const timing = {
  connectTimeoutMs: 1000,
  notCoordinatorRetryMs: 150,
  notCoordinatorRetries: 10,
  heartbeatMs: 500,
  heartbeatTimeoutMs: 2000,
  probeIntervalMs: 400,
  retryDelayMs: 300,
  reconnectDelayMs: 50,
};

async function startNode(name: string): Promise<{ node: SyncServer; origin: string }> {
  const node = createSyncServer({ alwaysHost: false, databaseFile: join(workDir, `${name}.sqlite`) });
  const port = await node.listen(0, "127.0.0.1");
  cleanups.push(() => node.close());
  return { node, origin: `http://127.0.0.1:${port}` };
}

type Peer = {
  session: RoomSession;
  view: () => SessionView;
  snapshot: () => SessionSnapshot | null;
};

function startPeer(input: {
  identity: StoredIdentity;
  roomId: string;
  inviteToken: string;
  roomKey: string;
  origin: string;
  bootstrap: string[];
  initial?: SessionSnapshot | null;
}): Peer {
  let lastView: SessionView | null = null;
  let lastSnapshot: SessionSnapshot | null = input.initial ?? null;
  const session = new RoomSession({
    roomId: input.roomId,
    inviteToken: input.inviteToken,
    roomKey: input.roomKey,
    identity: input.identity,
    bootstrapOrigins: input.bootstrap,
    localNode: { origin: input.origin, endpoints: [input.origin] },
    initial: input.initial,
    timing,
    onView: (view) => (lastView = view),
    onPersist: (snapshot) => (lastSnapshot = structuredClone(snapshot)),
  });
  session.start();
  cleanups.push(() => session.stop());
  return { session, view: () => lastView ?? session.getView(), snapshot: () => lastSnapshot };
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const texts = (peer: Peer) => peer.view().messages.map((message) => message.text);
const ids = (peer: Peer) => peer.view().messages.map((message) => message.id);

describe("critical E2E: coordinator crash and return", () => {
  it("A creates, B/C join, A crashes, B coordinates, A returns without duplicates", async () => {
    const identities = [createIdentity("A"), createIdentity("B"), createIdentity("C")];
    const [first, second] = [identities[1]!, identities[2]!].sort((l, r) => (l.peerId < r.peerId ? -1 : 1));
    const a = identities[0]!;
    const b = first!;
    const c = second!;

    const roomId = randomToken(8);
    const inviteToken = randomToken(24);
    const roomKey = generateRoomKey();

    let nodeA = await startNode("a");
    const nodeB = await startNode("b");
    const nodeC = await startNode("c");

    const initialState = createInitialRoomState({
      roomId,
      name: "Критический сценарий",
      ownerId: a.peerId,
      ownerName: a.displayName,
      ownerPublicKey: a.publicKey,
      endpoints: [nodeA.origin],
    });
    const common = { roomId, inviteToken, roomKey };
    let peerA = startPeer({ ...common, identity: a, origin: nodeA.origin, bootstrap: [], initial: { state: initialState, outbox: [] } });
    await waitFor("A coordinates", () => peerA.view().isCoordinator);

    const peerB = startPeer({ ...common, identity: b, origin: nodeB.origin, bootstrap: [nodeA.origin] });
    const peerC = startPeer({ ...common, identity: c, origin: nodeC.origin, bootstrap: [nodeA.origin] });
    await waitFor("B and C joined", () => peerB.view().status === "connected" && peerC.view().status === "connected");

    for (let index = 1; index <= 10; index += 1) {
      assert.equal(peerA.session.sendChat("general", `сообщение ${index}`), true);
    }
    await waitFor("10 messages replicated", () => texts(peerB).length === 10 && texts(peerC).length === 10);
    assert.equal(texts(peerC)[9], "сообщение 10");
    const snapshotBeforeCrash = peerA.snapshot();

    // Crash: the node dies first so no graceful LEAVE reaches anyone.
    await nodeA.node.close();
    peerA.session.stop();

    await waitFor("B took over", () => peerB.view().isCoordinator && peerB.view().status === "connected");
    await waitFor("C follows B", () => peerC.view().status === "connected" && peerC.view().state?.hostId === b.peerId);
    assert.ok((peerB.view().state?.epoch ?? 0) > (snapshotBeforeCrash?.state?.epoch ?? 0));
    assert.equal(texts(peerC).length, 10);

    assert.equal(peerC.session.sendChat("general", "пока A нет"), true);
    await waitFor("C message reached B", () => texts(peerB).includes("пока A нет"));

    nodeA = await startNode("a");
    peerA = startPeer({ ...common, identity: a, origin: nodeA.origin, bootstrap: [], initial: snapshotBeforeCrash });
    await waitFor("A rejoined as a regular peer", () => peerA.view().status === "connected");
    assert.equal(peerA.view().isCoordinator, false);
    assert.equal(peerA.view().state?.hostId, b.peerId);
    await waitFor("A caught up", () => texts(peerA).includes("пока A нет"));

    assert.equal(peerA.session.sendChat("general", "A снова здесь"), true);
    await waitFor("everyone sees A again", () =>
      [peerA, peerB, peerC].every((peer) => texts(peer).includes("A снова здесь")),
    );
    for (const peer of [peerA, peerB, peerC]) {
      assert.equal(texts(peer).length, 12);
      assert.equal(new Set(ids(peer)).size, 12, "no duplicates");
    }

    for (const peer of [peerA, peerB, peerC]) peer.session.stop();
    await Promise.all([nodeA.node.close(), nodeB.node.close(), nodeC.node.close()]);
  });
});

describe("split brain", () => {
  it("two peers that both coordinate converge on one without losing messages", async () => {
    const a = createIdentity("A");
    const b = createIdentity("B");
    const roomId = randomToken(8);
    const inviteToken = randomToken(24);
    const roomKey = generateRoomKey();
    const nodeA = await startNode("split-a");
    const nodeB = await startNode("split-b");

    const state = createInitialRoomState({
      roomId,
      name: "split",
      ownerId: a.peerId,
      ownerName: a.displayName,
      ownerPublicKey: a.publicKey,
      endpoints: [nodeA.origin],
    });
    state.members.push({
      id: b.peerId,
      name: b.displayName,
      role: "member",
      joinedAt: new Date().toISOString(),
      online: false,
      publicKey: b.publicKey,
      endpoints: [nodeB.origin],
    });
    const common = { roomId, inviteToken, roomKey, bootstrap: [] };
    const peerA = startPeer({ ...common, identity: a, origin: nodeA.origin, initial: { state, outbox: [] } });
    const peerB = startPeer({ ...common, identity: b, origin: nodeB.origin, initial: { state, outbox: [] } });
    peerA.session.sendChat("general", "от A во время раскола");
    peerB.session.sendChat("general", "от B во время раскола");

    await waitFor("single coordinator", () => {
      const [viewA, viewB] = [peerA.view(), peerB.view()];
      return (
        viewA.status === "connected" &&
        viewB.status === "connected" &&
        viewA.isCoordinator !== viewB.isCoordinator &&
        viewA.state?.hostId === viewB.state?.hostId
      );
    });
    await waitFor("both messages survive", () =>
      [peerA, peerB].every(
        (peer) => texts(peer).includes("от A во время раскола") && texts(peer).includes("от B во время раскола"),
      ),
    );

    peerA.session.stop();
    peerB.session.stop();
    await Promise.all([nodeA.node.close(), nodeB.node.close()]);
  });
});

describe("security", () => {
  async function rawJoin(origin: string, command: Record<string, unknown>): Promise<ServerEvent> {
    const socket = new WebSocket(`${origin.replace("http", "ws")}/api/ws`);
    return new Promise((resolve, reject) => {
      socket.onopen = () => socket.send(JSON.stringify(command));
      socket.onmessage = (event) => {
        resolve(JSON.parse(String(event.data)) as ServerEvent);
        socket.close();
      };
      socket.onerror = () => reject(new Error("socket error"));
    });
  }

  it("rejects a join whose proof was signed by another key", async () => {
    const node = createSyncServer({ alwaysHost: true, databaseFile: join(workDir, "security.sqlite") });
    const origin = `http://127.0.0.1:${await node.listen(0, "127.0.0.1")}`;
    const victim = createIdentity("Victim");
    const attacker = createIdentity("Attacker");
    const state = createInitialRoomState({
      roomId: "sec-room",
      name: "sec",
      ownerId: victim.peerId,
      ownerName: victim.displayName,
      ownerPublicKey: victim.publicKey,
      endpoints: [],
    });
    const ts = Date.now();
    const event = await rawJoin(origin, {
      type: "join",
      protocol: PROTOCOL_VERSION,
      roomId: "sec-room",
      inviteToken: "token",
      peerId: victim.peerId,
      displayName: "Victim",
      publicKey: attacker.publicKey,
      ts,
      proof: signText(attacker, joinProofText("sec-room", victim.peerId, ts)),
      endpoints: [],
      host: false,
      snapshot: state,
    });
    assert.equal(event.type, "error");
    assert.equal(event.type === "error" && event.code, "UNAUTHORIZED");
    await node.close();
  });

  it("drops forged messages from a replica and rejects forged live messages", async () => {
    const node = createSyncServer({ alwaysHost: true, databaseFile: join(workDir, "forged.sqlite") });
    const origin = `http://127.0.0.1:${await node.listen(0, "127.0.0.1")}`;
    const owner = createIdentity("Owner");
    const roomKey = generateRoomKey();
    const state = createInitialRoomState({
      roomId: "forged-room",
      name: "forged",
      ownerId: owner.peerId,
      ownerName: owner.displayName,
      ownerPublicKey: owner.publicKey,
      endpoints: [],
    });
    state.messages.push({
      id: "m-forged",
      channelId: "general",
      authorId: owner.peerId,
      author: "Owner",
      authorPublicKey: owner.publicKey,
      content: "e1.AAAA.BBBB",
      timestamp: new Date().toISOString(),
      signature: "00".repeat(64),
    });
    const errors: string[] = [];
    let view: SessionView | null = null;
    const session = new RoomSession({
      roomId: "forged-room",
      inviteToken: "token",
      roomKey,
      identity: owner,
      bootstrapOrigins: [origin],
      initial: { state, outbox: [] },
      timing,
      onView: (next) => (view = next),
      onError: (message) => errors.push(message),
    });
    session.start();
    await waitFor("connected", () => view?.status === "connected");
    assert.equal(view!.state?.messages.length, 0, "forged replica message was not imported");
    assert.equal(view!.messages.length, 0);

    assert.ok(session.sendChat("general", "настоящее"));
    await waitFor("real message synced", () => view!.messages.some((message) => message.delivery === "synced"));
    session.stop();
    await node.close();
  });
});

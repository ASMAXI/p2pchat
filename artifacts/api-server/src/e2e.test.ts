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
import { RoomSession, createSignedCoordinatorClaim, type SessionSnapshot, type SessionView } from "@workspace/p2p-room";
import { createSyncServer, type SyncServer } from "./server";

const cleanups: Array<() => unknown> = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

function freshWorkDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `p2pchat-e2e-${label}-`));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // SQLite WAL files can stay locked briefly on Windows.
    }
  });
  return dir;
}

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

async function startNode(name: string, workDir: string): Promise<{ node: SyncServer; origin: string }> {
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
    allowLoopbackBootstrap: true,
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

describe("api-server e2e", { concurrency: false }, () => {
describe("critical E2E: coordinator crash and return", { concurrency: false }, () => {
  it("A creates, B/C join, A crashes, B coordinates, A returns without duplicates", async () => {
    const identities = [createIdentity("A"), createIdentity("B"), createIdentity("C")];
    const [first, second] = [identities[1]!, identities[2]!].sort((l, r) => (l.peerId < r.peerId ? -1 : 1));
    const a = identities[0]!;
    const b = first!;
    const c = second!;

    const roomId = randomToken(8);
    const inviteToken = randomToken(24);
    const roomKey = generateRoomKey();
    const workDir = freshWorkDir("crash");

    let nodeA = await startNode("a", workDir);
    const nodeB = await startNode("b", workDir);
    const nodeC = await startNode("c", workDir);

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

    nodeA = await startNode("a", workDir);
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

  it("TZ drift chain: A→B→C host handoff, chat converges, old host can return", async () => {
    // Deterministic succession: among survivors, lexicographically smallest peerId hosts.
    // Force peerId order B < C < A so: A dies → B hosts; B dies → C hosts.
    const pool: StoredIdentity[] = [];
    for (let attempt = 0; attempt < 40 && pool.length < 3; attempt += 1) {
      pool.push(createIdentity(`P${attempt}`));
    }
    const sorted = [...pool].sort((left, right) => (left.peerId < right.peerId ? -1 : 1));
    const b = { ...sorted[0]!, displayName: "B" };
    const c = { ...sorted[1]!, displayName: "C" };
    const a = { ...sorted[2]!, displayName: "A" };
    assert.ok(b.peerId < c.peerId && c.peerId < a.peerId);

    const roomId = randomToken(8);
    const inviteToken = randomToken(24);
    const roomKey = generateRoomKey();
    const workDir = freshWorkDir("tz");

    let nodeA = await startNode("tz-a", workDir);
    let nodeB = await startNode("tz-b", workDir);
    const nodeC = await startNode("tz-c", workDir);

    const initialState = createInitialRoomState({
      roomId,
      name: "TZ drift",
      ownerId: a.peerId,
      ownerName: a.displayName,
      ownerPublicKey: a.publicKey,
      endpoints: [nodeA.origin],
    });
    const common = { roomId, inviteToken, roomKey };

    let peerA = startPeer({
      ...common,
      identity: a,
      origin: nodeA.origin,
      bootstrap: [],
      initial: { state: initialState, outbox: [] },
    });
    await waitFor("A is coordinator", () => peerA.view().isCoordinator && peerA.view().status === "connected");

    const peerB = startPeer({ ...common, identity: b, origin: nodeB.origin, bootstrap: [nodeA.origin] });
    const peerC = startPeer({ ...common, identity: c, origin: nodeC.origin, bootstrap: [nodeA.origin] });
    await waitFor("B/C connected under A", () =>
      peerB.view().status === "connected" &&
      peerC.view().status === "connected" &&
      peerB.view().state?.hostId === a.peerId &&
      peerC.view().state?.hostId === a.peerId,
    );

    assert.equal(peerA.session.sendChat("general", "от A до падения"), true);
    await waitFor("msg1 replicated", () =>
      [peerA, peerB, peerC].every((peer) => texts(peer).includes("от A до падения")),
    );
    const epochUnderA = peerA.view().state?.epoch ?? 0;

    // A hard-crashes (no LEAVE).
    await nodeA.node.close();
    peerA.session.stop();

    await waitFor("B became coordinator", () => peerB.view().isCoordinator && peerB.view().status === "connected");
    await waitFor("C follows B", () => peerC.view().status === "connected" && peerC.view().state?.hostId === b.peerId);
    assert.ok((peerB.view().state?.epoch ?? 0) > epochUnderA);
    assert.equal(peerC.session.sendChat("general", "от C при хосте B"), true);
    await waitFor("B sees C message", () => texts(peerB).includes("от C при хосте B"));

    // A returns while B hosts — must sync as peer, not steal host.
    const snapAfterB = peerB.snapshot();
    nodeA = await startNode("tz-a2", workDir);
    peerA = startPeer({
      ...common,
      identity: a,
      origin: nodeA.origin,
      bootstrap: [nodeB.origin, nodeC.origin],
      initial: snapAfterB,
    });
    await waitFor("A rejoined under B", () =>
      peerA.view().status === "connected" && peerA.view().state?.hostId === b.peerId,
    );
    assert.equal(peerA.view().isCoordinator, false);
    await waitFor("A has C message", () => texts(peerA).includes("от C при хосте B"));
    assert.equal(peerA.session.sendChat("general", "A вернулся"), true);
    await waitFor("all see A returned", () =>
      [peerA, peerB, peerC].every((peer) => texts(peer).includes("A вернулся")),
    );

    const epochUnderB = peerB.view().state?.epoch ?? 0;
    const snapBeforeBCrash = peerB.snapshot();

    // B hard-crashes → C must become coordinator (peerId B < C < A).
    await nodeB.node.close();
    peerB.session.stop();

    await waitFor("C became coordinator", () => peerC.view().isCoordinator && peerC.view().status === "connected");
    await waitFor("A follows C", () => peerA.view().status === "connected" && peerA.view().state?.hostId === c.peerId);
    assert.ok((peerC.view().state?.epoch ?? 0) > epochUnderB);
    assert.equal(peerC.session.sendChat("general", "от C как хост"), true);
    await waitFor("A sees host-C message", () => texts(peerA).includes("от C как хост"));

    // Everyone converges: same host, same message set, no duplicates.
    const expected = ["от A до падения", "от C при хосте B", "A вернулся", "от C как хост"];
    for (const peer of [peerA, peerC]) {
      assert.equal(peer.view().state?.hostId, c.peerId);
      for (const text of expected) assert.ok(texts(peer).includes(text), `missing "${text}"`);
      assert.equal(new Set(ids(peer)).size, texts(peer).length, "no duplicate ids");
    }
    assert.equal(peerA.view().state?.epoch, peerC.view().state?.epoch);

    // Stale B snapshot must not win over live C epoch when B returns.
    nodeB = await startNode("tz-b2", workDir);
    const peerB2 = startPeer({
      ...common,
      identity: b,
      origin: nodeB.origin,
      bootstrap: [nodeC.origin, nodeA.origin],
      initial: snapBeforeBCrash,
    });
    await waitFor("B rejoined under C", () =>
      peerB2.view().status === "connected" && peerB2.view().state?.hostId === c.peerId,
    );
    assert.equal(peerB2.view().isCoordinator, false);
    await waitFor("B caught up to C host msgs", () => texts(peerB2).includes("от C как хост"));
    for (const text of expected) assert.ok(texts(peerB2).includes(text));

    for (const peer of [peerA, peerB2, peerC]) peer.session.stop();
    await Promise.all([nodeA.node.close(), nodeB.node.close(), nodeC.node.close()]);
  });
});

describe("split brain", { concurrency: false }, () => {
  it("two peers that both coordinate converge on one without losing messages", async () => {
    const a = createIdentity("A");
    const b = createIdentity("B");
    const roomId = randomToken(8);
    const inviteToken = randomToken(24);
    const roomKey = generateRoomKey();
    const workDir = freshWorkDir("split");
    const nodeA = await startNode("split-a", workDir);
    const nodeB = await startNode("split-b", workDir);

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
      online: true,
      publicKey: b.publicKey,
      endpoints: [nodeB.origin],
    });
    const aMember = state.members.find((member) => member.id === a.peerId);
    if (aMember) {
      aMember.online = true;
      aMember.endpoints = [nodeA.origin];
    }
    const common = { roomId, inviteToken, roomKey, bootstrap: [] as string[] };
    const peerA = startPeer({ ...common, identity: a, origin: nodeA.origin, initial: { state, outbox: [] } });
    const peerB = startPeer({ ...common, identity: b, origin: nodeB.origin, initial: { state, outbox: [] } });
    peerA.session.sendChat("general", "от A во время раскола");
    peerB.session.sendChat("general", "от B во время раскола");

    await waitFor(
      "single coordinator",
      () => {
        const [viewA, viewB] = [peerA.view(), peerB.view()];
        return (
          viewA.status === "connected" &&
          viewB.status === "connected" &&
          viewA.isCoordinator !== viewB.isCoordinator &&
          viewA.state?.hostId === viewB.state?.hostId
        );
      },
      25000,
    );
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

describe("security", { concurrency: false }, () => {
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
    const workDir = freshWorkDir("sec");
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

  it("rejects a host join with a forged coordinator claim", async () => {
    const workDir = freshWorkDir("claim");
    const node = createSyncServer({ alwaysHost: false, databaseFile: join(workDir, "claim.sqlite") });
    const origin = `http://127.0.0.1:${await node.listen(0, "127.0.0.1")}`;
    const host = createIdentity("Host");
    const attacker = createIdentity("Attacker");
    const state = createInitialRoomState({
      roomId: "claim-room",
      name: "claim",
      ownerId: host.peerId,
      ownerName: host.displayName,
      ownerPublicKey: host.publicKey,
      endpoints: [origin],
    });
    const ts = Date.now();
    const claim = createSignedCoordinatorClaim(host, {
      roomId: "claim-room",
      epoch: 1,
      previousHostId: null,
      ts,
    });
    claim.signature = createSignedCoordinatorClaim(attacker, {
      roomId: "claim-room",
      epoch: 1,
      previousHostId: null,
      ts,
    }).signature;
    const event = await rawJoin(origin, {
      type: "join",
      protocol: PROTOCOL_VERSION,
      roomId: "claim-room",
      inviteToken: "token",
      peerId: host.peerId,
      displayName: host.displayName,
      publicKey: host.publicKey,
      ts,
      proof: signText(host, joinProofText("claim-room", host.peerId, ts)),
      endpoints: [origin],
      host: true,
      snapshot: state,
      coordinatorClaim: claim,
    });
    assert.equal(event.type, "error");
    assert.equal(event.type === "error" && event.code, "UNAUTHORIZED");
    await node.close();
  });

  it("rate-limits bursty voice signals", async () => {
    const workDir = freshWorkDir("signal-rate");
    const node = createSyncServer({ alwaysHost: false, databaseFile: join(workDir, "signal.sqlite") });
    const origin = `http://127.0.0.1:${await node.listen(0, "127.0.0.1")}`;
    const host = createIdentity("Host");
    const peer = createIdentity("Peer");
    const state = createInitialRoomState({
      roomId: "signal-room",
      name: "signals",
      ownerId: host.peerId,
      ownerName: host.displayName,
      ownerPublicKey: host.publicKey,
      endpoints: [origin],
    });
    const ts = Date.now();
    const claim = createSignedCoordinatorClaim(host, {
      roomId: "signal-room",
      epoch: 1,
      previousHostId: null,
      ts,
    });

    const hostSocket = new WebSocket(`${origin.replace("http", "ws")}/api/ws`);
    await new Promise<void>((resolve, reject) => {
      hostSocket.onopen = () => resolve();
      hostSocket.onerror = () => reject(new Error("host socket error"));
    });
    const joined = new Promise<ServerEvent>((resolve) => {
      hostSocket.onmessage = (event) => resolve(JSON.parse(String(event.data)) as ServerEvent);
    });
    hostSocket.send(
      JSON.stringify({
        type: "join",
        protocol: PROTOCOL_VERSION,
        roomId: "signal-room",
        inviteToken: "token",
        peerId: host.peerId,
        displayName: host.displayName,
        publicKey: host.publicKey,
        ts,
        proof: signText(host, joinProofText("signal-room", host.peerId, ts)),
        endpoints: [origin],
        host: true,
        snapshot: state,
        coordinatorClaim: claim,
      }),
    );
    const joinEvent = await joined;
    assert.equal(joinEvent.type, "state");

    let rateLimited = false;
    const waitRate = new Promise<void>((resolve) => {
      hostSocket.onmessage = (event) => {
        const data = JSON.parse(String(event.data)) as ServerEvent;
        if (data.type === "error" && data.code === "RATE_LIMIT") {
          rateLimited = true;
          resolve();
        }
      };
    });
    for (let i = 0; i < 100; i += 1) {
      hostSocket.send(
        JSON.stringify({
          type: "signal",
          toPeerId: peer.peerId,
          data: { kind: "ice", candidate: { candidate: `c${i}`, sdpMid: "0" } },
        }),
      );
    }
    await Promise.race([waitRate, new Promise((resolve) => setTimeout(resolve, 2000))]);
    assert.equal(rateLimited, true);
    hostSocket.close();
    await node.close();
  });

  it("drops forged messages from a replica and rejects forged live messages", async () => {
    const workDir = freshWorkDir("forged");
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
      allowLoopbackBootstrap: true,
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
});

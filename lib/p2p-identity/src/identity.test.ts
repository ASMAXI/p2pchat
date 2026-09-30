import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createIdentity,
  decryptContent,
  encryptContent,
  generateRoomKey,
  loadOrCreateIdentity,
  peerIdFromPublicKey,
  signText,
  verifyPeerSignature,
  verifyText,
} from "./index";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

describe("identity", () => {
  it("derives peerId from the public key", () => {
    const identity = createIdentity("Test");
    assert.equal(identity.peerId, peerIdFromPublicKey(identity.publicKey));
  });

  it("signs and verifies text", () => {
    const identity = createIdentity("Signer");
    const signature = signText(identity, "hello");
    assert.equal(verifyText(identity.publicKey, "hello", signature), true);
    assert.equal(verifyText(identity.publicKey, "hellO", signature), false);
  });

  it("rejects a signature claimed by a foreign peerId", () => {
    const alice = createIdentity("Alice");
    const mallory = createIdentity("Mallory");
    const signature = signText(mallory, "payload");
    assert.equal(verifyPeerSignature(alice.peerId, mallory.publicKey, "payload", signature), false);
    assert.equal(verifyPeerSignature(mallory.peerId, mallory.publicKey, "payload", signature), true);
  });

  it("keeps identity stable across loads and renames", () => {
    const storage = memoryStorage();
    const first = loadOrCreateIdentity("Миша", storage);
    const second = loadOrCreateIdentity("Михаил", storage);
    assert.equal(second.peerId, first.peerId);
    assert.equal(second.displayName, "Михаил");
  });

  it("replaces a corrupted stored identity", () => {
    const storage = memoryStorage();
    storage.setItem("p2pchat-crypto-identity", "{broken");
    const identity = loadOrCreateIdentity("Лена", storage);
    assert.ok(identity.peerId);
  });
});

describe("content encryption", () => {
  it("round-trips and binds ciphertext to aad", () => {
    const key = generateRoomKey();
    const sealed = encryptContent(key, "секрет", "room/m1");
    assert.equal(decryptContent(key, sealed, "room/m1"), "секрет");
    assert.equal(decryptContent(key, sealed, "room/m2"), null);
    assert.equal(decryptContent(generateRoomKey(), sealed, "room/m1"), null);
  });
});

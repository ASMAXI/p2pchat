import * as ed from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { toBase64Url } from "./encoding";

ed.etc.sha512Sync = (...messages) => sha512(ed.etc.concatBytes(...messages));

export { decryptContent, encryptContent, generateRoomKey } from "./content-crypto";
export { fromBase64Url, randomToken, toBase64Url } from "./encoding";

export type StoredIdentity = {
  publicKey: string;
  privateKey: string;
  peerId: string;
  displayName: string;
  createdAt: string;
};

export type IdentityStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const IDENTITY_KEY = "p2pchat-crypto-identity";

export function peerIdFromPublicKey(publicKey: Uint8Array | string): string {
  const bytes = typeof publicKey === "string" ? hexToBytes(publicKey) : publicKey;
  return toBase64Url(sha256(bytes).slice(0, 16));
}

function normalizeName(displayName: string): string {
  return displayName.normalize("NFC").trim().slice(0, 40) || "Участник";
}

export function createIdentity(displayName: string): StoredIdentity {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = ed.getPublicKey(privateKey);
  return {
    publicKey: bytesToHex(publicKey),
    privateKey: bytesToHex(privateKey),
    peerId: peerIdFromPublicKey(publicKey),
    displayName: normalizeName(displayName),
    createdAt: new Date().toISOString(),
  };
}

export function signText(identity: StoredIdentity, text: string): string {
  return bytesToHex(ed.sign(utf8ToBytes(text), hexToBytes(identity.privateKey)));
}

export function verifyText(publicKeyHex: string, text: string, signatureHex: string): boolean {
  try {
    return ed.verify(hexToBytes(signatureHex), utf8ToBytes(text), hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}

/** Checks that `peerId` is derived from `publicKeyHex` and the signature is valid. */
export function verifyPeerSignature(
  peerId: string,
  publicKeyHex: string,
  text: string,
  signatureHex: string,
): boolean {
  try {
    if (peerIdFromPublicKey(publicKeyHex) !== peerId) return false;
  } catch {
    return false;
  }
  return verifyText(publicKeyHex, text, signatureHex);
}

function isValidIdentity(value: unknown): value is StoredIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<StoredIdentity>;
  if (!identity.publicKey || !identity.privateKey || !identity.peerId) return false;
  try {
    const derived = bytesToHex(ed.getPublicKey(hexToBytes(identity.privateKey)));
    return derived === identity.publicKey && peerIdFromPublicKey(derived) === identity.peerId;
  } catch {
    return false;
  }
}

export function loadIdentity(storage: IdentityStorage = localStorage): StoredIdentity | null {
  try {
    const raw = storage.getItem(IDENTITY_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValidIdentity(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveIdentity(identity: StoredIdentity, storage: IdentityStorage = localStorage): void {
  storage.setItem(IDENTITY_KEY, JSON.stringify(identity));
}

export function loadOrCreateIdentity(
  displayName: string,
  storage: IdentityStorage = localStorage,
): StoredIdentity {
  const existing = loadIdentity(storage);
  if (existing) {
    const name = displayName.trim() ? normalizeName(displayName) : existing.displayName;
    if (name === existing.displayName) return existing;
    const renamed = { ...existing, displayName: name };
    saveIdentity(renamed, storage);
    return renamed;
  }
  const created = createIdentity(displayName);
  saveIdentity(created, storage);
  return created;
}

import { gcm } from "@noble/ciphers/aes";
import { randomBytes } from "@noble/ciphers/webcrypto";
import { utf8ToBytes } from "@noble/hashes/utils";
import { fromBase64Url, toBase64Url } from "./encoding";

const PREFIX = "e1";

export function generateRoomKey(): string {
  return toBase64Url(randomBytes(32));
}

/** AES-256-GCM; `aad` binds the ciphertext to its room and message id. */
export function encryptContent(roomKey: string, plaintext: string, aad: string): string {
  const nonce = randomBytes(12);
  const cipher = gcm(fromBase64Url(roomKey), nonce, utf8ToBytes(aad));
  const sealed = cipher.encrypt(utf8ToBytes(plaintext));
  return `${PREFIX}.${toBase64Url(nonce)}.${toBase64Url(sealed)}`;
}

export function decryptContent(roomKey: string, payload: string, aad: string): string | null {
  const [prefix, nonce, sealed] = payload.split(".");
  if (prefix !== PREFIX || !nonce || !sealed) return null;
  try {
    const cipher = gcm(fromBase64Url(roomKey), fromBase64Url(nonce), utf8ToBytes(aad));
    return new TextDecoder().decode(cipher.decrypt(fromBase64Url(sealed)));
  } catch {
    return null;
  }
}

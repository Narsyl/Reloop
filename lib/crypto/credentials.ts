/**
 * Credential encryption for integration secrets stored in PostgreSQL.
 *
 * - AES-256-GCM, random 96-bit IV per encryption
 * - AAD binds the ciphertext to the owning row (e.g. the integration id), so a
 *   blob copied between rows does not decrypt
 * - Versioned, key-id-tagged format enables rotation:
 *     v1.<keyId>.<iv>.<tag>.<ciphertext>   (all base64url)
 *
 * Keys come from CREDENTIAL_ENCRYPTION_KEYS = "keyId:base64key[,keyId:base64key...]".
 * The first entry is the current key used for new encryptions; older entries
 * remain so existing rows can be decrypted and re-encrypted.
 *
 * This module is server-only. Decrypted values must never be returned to the
 * client or written to logs.
 */
import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const FORMAT_VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

type KeyRing = { currentKeyId: string; keys: Map<string, Buffer> };

let cachedRing: KeyRing | null = null;

export class CredentialCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialCryptoError";
  }
}

export function loadKeyRing(raw = process.env.CREDENTIAL_ENCRYPTION_KEYS): KeyRing {
  if (cachedRing && raw === cachedRaw) return cachedRing;
  if (!raw || !raw.trim()) {
    throw new CredentialCryptoError("CREDENTIAL_ENCRYPTION_KEYS is not configured");
  }
  const keys = new Map<string, Buffer>();
  let currentKeyId: string | null = null;
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    if (sep <= 0) {
      throw new CredentialCryptoError("CREDENTIAL_ENCRYPTION_KEYS entry must be 'keyId:base64key'");
    }
    const keyId = trimmed.slice(0, sep);
    const key = Buffer.from(trimmed.slice(sep + 1), "base64");
    if (key.length !== KEY_BYTES) {
      throw new CredentialCryptoError(`Key '${keyId}' must decode to ${KEY_BYTES} bytes`);
    }
    if (keys.has(keyId)) {
      throw new CredentialCryptoError(`Duplicate key id '${keyId}'`);
    }
    keys.set(keyId, key);
    currentKeyId ??= keyId;
  }
  if (!currentKeyId) {
    throw new CredentialCryptoError("CREDENTIAL_ENCRYPTION_KEYS contains no keys");
  }
  cachedRaw = raw;
  cachedRing = { currentKeyId, keys };
  return cachedRing;
}
let cachedRaw: string | undefined;

/** For tests / rotation tooling. */
export function resetKeyRingCache() {
  cachedRing = null;
  cachedRaw = undefined;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

/**
 * Encrypt a JSON-serialisable secret bound to `aad` (use the owning row id).
 * Returns the versioned blob to store in the database.
 */
export function encryptCredentials(secret: unknown, aad: string): string {
  const ring = loadKeyRing();
  const key = ring.keys.get(ring.currentKeyId)!;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const plaintext = Buffer.from(JSON.stringify(secret), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT_VERSION, ring.currentKeyId, b64url(iv), b64url(tag), b64url(ciphertext)].join(".");
}

/**
 * Decrypt a blob produced by encryptCredentials. Throws on tampering, wrong
 * AAD, unknown key id, or malformed input.
 */
export function decryptCredentials<T = unknown>(blob: string, aad: string): T {
  const parts = blob.split(".");
  if (parts.length !== 5 || parts[0] !== FORMAT_VERSION) {
    throw new CredentialCryptoError("Unrecognised credential blob format");
  }
  const [, keyId, ivB64, tagB64, ctB64] = parts;
  const ring = loadKeyRing();
  const key = ring.keys.get(keyId);
  if (!key) {
    throw new CredentialCryptoError(`No encryption key '${keyId}' available for decryption`);
  }
  const decipher = createDecipheriv(ALGORITHM, key, fromB64url(ivB64));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(fromB64url(tagB64));
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(fromB64url(ctB64)), decipher.final()]);
  } catch {
    throw new CredentialCryptoError("Credential blob failed authentication");
  }
  return JSON.parse(plaintext.toString("utf8")) as T;
}

/** Key id a blob was encrypted with (for rotation tooling). */
export function blobKeyId(blob: string): string | null {
  const parts = blob.split(".");
  return parts.length === 5 && parts[0] === FORMAT_VERSION ? parts[1] : null;
}

/** True if the blob should be re-encrypted with the current key. */
export function needsRotation(blob: string): boolean {
  const ring = loadKeyRing();
  return blobKeyId(blob) !== ring.currentKeyId;
}

/** Redact anything that looks like a secret before it reaches a log line. */
export function redactSecret(value: string | undefined | null): string {
  if (!value) return "";
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`;
}

/**
 * True when this host holds the key needed to decrypt `blob` (format + key id
 * check only — no decryption). Used by background schedulers to skip rows
 * that can never be opened here (seed placeholders, keys rotated out) instead
 * of creating a failing run every slot.
 */
export function hasDecryptionKeyFor(blob: string): boolean {
  const parts = blob.split(".");
  if (parts.length !== 5 || parts[0] !== FORMAT_VERSION) return false;
  try {
    return loadKeyRing().keys.has(parts[1]);
  } catch {
    return false;
  }
}

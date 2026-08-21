import { beforeEach, describe, expect, it } from "vitest";
import {
  CredentialCryptoError,
  blobKeyId,
  decryptCredentials,
  encryptCredentials,
  loadKeyRing,
  needsRotation,
  redactSecret,
  resetKeyRingCache,
} from "@/lib/crypto/credentials";

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");

describe("credential encryption", () => {
  beforeEach(() => {
    resetKeyRingCache();
    process.env.CREDENTIAL_ENCRYPTION_KEYS = `k1:${KEY_A}`;
  });

  it("round-trips a secret object bound to an AAD", () => {
    const secret = { apiToken: "sk_live_abc", clientSecret: "whsec_123" };
    const blob = encryptCredentials(secret, "integration_1");
    expect(blob.startsWith("v1.k1.")).toBe(true);
    expect(blob).not.toContain("sk_live_abc");
    expect(decryptCredentials(blob, "integration_1")).toEqual(secret);
  });

  it("produces a different blob each time (random IV)", () => {
    const a = encryptCredentials({ t: 1 }, "x");
    const b = encryptCredentials({ t: 1 }, "x");
    expect(a).not.toEqual(b);
  });

  it("refuses to decrypt under a different AAD (row binding)", () => {
    const blob = encryptCredentials({ apiToken: "t" }, "integration_1");
    expect(() => decryptCredentials(blob, "integration_2")).toThrow(CredentialCryptoError);
  });

  it("detects tampering with the ciphertext", () => {
    const blob = encryptCredentials({ apiToken: "t" }, "i");
    const parts = blob.split(".");
    const ct = Buffer.from(parts[4], "base64url");
    ct[0] ^= 0xff;
    parts[4] = ct.toString("base64url");
    expect(() => decryptCredentials(parts.join("."), "i")).toThrow(CredentialCryptoError);
  });

  it("rejects malformed blobs and unknown key ids", () => {
    expect(() => decryptCredentials("garbage", "i")).toThrow(CredentialCryptoError);
    const blob = encryptCredentials({ a: 1 }, "i").replace("v1.k1.", "v1.k9.");
    expect(() => decryptCredentials(blob, "i")).toThrow(/No encryption key 'k9'/);
  });

  it("supports key rotation: old blobs decrypt, new blobs use the current key", () => {
    const oldBlob = encryptCredentials({ apiToken: "old" }, "i");
    resetKeyRingCache();
    process.env.CREDENTIAL_ENCRYPTION_KEYS = `k2:${KEY_B},k1:${KEY_A}`;
    expect(loadKeyRing().currentKeyId).toBe("k2");
    expect(decryptCredentials(oldBlob, "i")).toEqual({ apiToken: "old" });
    expect(needsRotation(oldBlob)).toBe(true);
    const newBlob = encryptCredentials({ apiToken: "new" }, "i");
    expect(blobKeyId(newBlob)).toBe("k2");
    expect(needsRotation(newBlob)).toBe(false);
  });

  it("validates the key ring configuration", () => {
    resetKeyRingCache();
    process.env.CREDENTIAL_ENCRYPTION_KEYS = "";
    expect(() => encryptCredentials({}, "i")).toThrow(/not configured/);
    resetKeyRingCache();
    process.env.CREDENTIAL_ENCRYPTION_KEYS = "k1:tooShort";
    expect(() => encryptCredentials({}, "i")).toThrow(/32 bytes/);
    resetKeyRingCache();
    process.env.CREDENTIAL_ENCRYPTION_KEYS = `k1:${KEY_A},k1:${KEY_B}`;
    expect(() => encryptCredentials({}, "i")).toThrow(/Duplicate/);
  });

  it("redacts secrets for logging", () => {
    expect(redactSecret("sk_live_abcdefghijkl")).toBe("sk_l…kl (20 chars)");
    expect(redactSecret("short")).toBe("••••");
    expect(redactSecret(undefined)).toBe("");
  });
});

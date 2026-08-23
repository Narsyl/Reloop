import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeRechargeSignature, verifyRechargeWebhookSignature } from "@/lib/integrations/recharge/webhooks";

const secret = "whsec_test_secret_value";
const body = JSON.stringify({ order: { id: 123, status: "success" } });

/** Independent reproduction of Recharge's DOCUMENTED algorithm: sha256(secret || raw body), hex. */
const documentedDigest = (b: string, s: string) => createHash("sha256").update(s, "utf8").update(b).digest("hex");

describe("Recharge webhook signature — documented sha256(secret + raw body), hex", () => {
  it("matches an independently computed documented digest exactly", () => {
    expect(computeRechargeSignature(body, secret)).toBe(documentedDigest(body, secret));
    expect(verifyRechargeWebhookSignature({ rawBody: body, signature: documentedDigest(body, secret), clientSecret: secret })).toBe(true);
  });
  it("accepts uppercase hex from the header but nothing else", () => {
    expect(verifyRechargeWebhookSignature({ rawBody: body, signature: documentedDigest(body, secret).toUpperCase(), clientSecret: secret })).toBe(true);
  });
  it("REJECTS a standard keyed HMAC-SHA256 — the algorithm Recharge does NOT use (regression)", () => {
    const keyedHmac = createHmac("sha256", secret).update(body).digest("hex");
    expect(keyedHmac).not.toBe(documentedDigest(body, secret));
    expect(verifyRechargeWebhookSignature({ rawBody: body, signature: keyedHmac, clientSecret: secret })).toBe(false);
  });
  it("REJECTS the wrong concatenation order (body + secret) — docs: secret must come first", () => {
    const wrongOrder = createHash("sha256").update(body).update(secret, "utf8").digest("hex");
    expect(verifyRechargeWebhookSignature({ rawBody: body, signature: wrongOrder, clientSecret: secret })).toBe(false);
  });
  it("rejects a base64 digest — only the documented hex encoding is accepted", () => {
    const base64 = createHash("sha256").update(secret, "utf8").update(body).digest("base64");
    expect(verifyRechargeWebhookSignature({ rawBody: body, signature: base64, clientSecret: secret })).toBe(false);
  });
  it("a single changed byte or lost space in the raw body breaks validation (docs warning)", () => {
    const sig = documentedDigest(body, secret);
    expect(verifyRechargeWebhookSignature({ rawBody: body.replace("success", "succesS"), signature: sig, clientSecret: secret })).toBe(false);
    expect(verifyRechargeWebhookSignature({ rawBody: body.replace('":', '": '), signature: sig, clientSecret: secret })).toBe(false);
  });
  it("rejects the wrong secret, missing header, missing secret", () => {
    const sig = documentedDigest(body, secret);
    expect(verifyRechargeWebhookSignature({ rawBody: body, signature: sig, clientSecret: "other" })).toBe(false);
    expect(verifyRechargeWebhookSignature({ rawBody: body, signature: null, clientSecret: secret })).toBe(false);
    expect(verifyRechargeWebhookSignature({ rawBody: body, signature: sig, clientSecret: null })).toBe(false);
  });
  it("rejects malformed signatures of any length without throwing", () => {
    expect(verifyRechargeWebhookSignature({ rawBody: body, signature: "abc", clientSecret: secret })).toBe(false);
    expect(verifyRechargeWebhookSignature({ rawBody: body, signature: "z".repeat(64), clientSecret: secret })).toBe(false);
    expect(verifyRechargeWebhookSignature({ rawBody: body, signature: "0".repeat(65), clientSecret: secret })).toBe(false);
  });
  it("hashes raw bytes untouched — Buffer and identical string agree; different unicode bytes differ", () => {
    expect(verifyRechargeWebhookSignature({ rawBody: Buffer.from(body, "utf8"), signature: documentedDigest(body, secret), clientSecret: secret })).toBe(true);
    const unicode = '{"note":"café"}';
    expect(computeRechargeSignature(unicode, secret)).toBe(createHash("sha256").update(secret, "utf8").update(Buffer.from(unicode, "utf8")).digest("hex"));
  });
});

import { describe, expect, it } from "vitest";
import { computeRechargeSignature, verifyRechargeWebhookSignature } from "@/lib/integrations/recharge/webhooks";

const secret = "whsec_test_secret_value";
const body = JSON.stringify({ order: { id: 123, status: "success" } });

describe("Recharge webhook signature", () => {
  it("accepts a valid hex signature", () => {
    const sig = computeRechargeSignature(body, secret, "hex");
    expect(verifyRechargeWebhookSignature({ rawBody: body, signature: sig, clientSecret: secret })).toBe(true);
  });
  it("accepts a valid base64 signature", () => {
    const sig = computeRechargeSignature(body, secret, "base64");
    expect(verifyRechargeWebhookSignature({ rawBody: body, signature: sig, clientSecret: secret })).toBe(true);
  });
  it("rejects a tampered body", () => {
    const sig = computeRechargeSignature(body, secret);
    expect(verifyRechargeWebhookSignature({ rawBody: body.replace("success", "error"), signature: sig, clientSecret: secret })).toBe(false);
  });
  it("rejects the wrong secret, missing header, missing secret", () => {
    const sig = computeRechargeSignature(body, secret);
    expect(verifyRechargeWebhookSignature({ rawBody: body, signature: sig, clientSecret: "other" })).toBe(false);
    expect(verifyRechargeWebhookSignature({ rawBody: body, signature: null, clientSecret: secret })).toBe(false);
    expect(verifyRechargeWebhookSignature({ rawBody: body, signature: sig, clientSecret: null })).toBe(false);
  });
  it("rejects signatures of the wrong length without throwing", () => {
    expect(verifyRechargeWebhookSignature({ rawBody: body, signature: "abc", clientSecret: secret })).toBe(false);
  });
});

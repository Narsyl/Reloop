/**
 * Recharge webhook utilities — Phase 2 ships only what is needed later for
 * verification; registration/listing of webhooks arrives with Phase 6.
 *
 * Recharge signs webhook deliveries with HMAC-SHA256 of the raw request body
 * using the API client secret, sent as the `X-Recharge-Hmac-Sha256` header.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const RECHARGE_SIGNATURE_HEADER = "x-recharge-hmac-sha256";

/** Topics the platform will subscribe to in Phase 6 (permissioned via read_orders / read_subscriptions). */
export const RECHARGE_WEBHOOK_TOPICS = [
  "order/created",
  "order/processed",
  "order/updated",
  "subscription/created",
  "subscription/updated",
  "subscription/cancelled",
  "subscription/activated",
  "subscription/skipped",
  "subscription/unskipped",
  "subscription/swapped",
  "onetime/created",
  "onetime/updated",
  "onetime/deleted",
] as const;
export type RechargeWebhookTopic = (typeof RECHARGE_WEBHOOK_TOPICS)[number];

export function computeRechargeSignature(rawBody: string | Buffer, clientSecret: string, encoding: "hex" | "base64" = "hex"): string {
  return createHmac("sha256", clientSecret).update(rawBody).digest(encoding);
}

/**
 * Constant-time verification. Accepts hex (Recharge's documented format) and
 * base64 digests so a format change upstream does not silently reject everything.
 */
export function verifyRechargeWebhookSignature(params: { rawBody: string | Buffer; signature: string | null | undefined; clientSecret: string | null | undefined }): boolean {
  const { rawBody, signature, clientSecret } = params;
  if (!signature || !clientSecret) return false;
  const provided = signature.trim();
  for (const enc of ["hex", "base64"] as const) {
    const expected = computeRechargeSignature(rawBody, clientSecret, enc);
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

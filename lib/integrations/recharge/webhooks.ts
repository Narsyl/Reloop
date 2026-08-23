/**
 * Recharge webhook utilities (Phase 5).
 *
 * Signature: despite the header name `X-Recharge-Hmac-Sha256`, Recharge's documented validation
 * is NOT a keyed HMAC. Per the official docs (docs.getrecharge.com/docs/webhooks-overview,
 * verified 23 Aug 2026) it is a PLAIN SHA-256 digest of the API client secret concatenated with
 * the EXACT raw request body — secret first — hex-encoded:
 *
 *     expected = sha256( utf8(client_secret) || raw_body_bytes ).hexdigest()
 *
 * The docs warn that "validation will fail even if one space is lost", so the raw bytes must be
 * hashed untouched (no JSON re-serialisation, no whitespace normalisation) and the secret must come
 * BEFORE the body ("adding client_secret after req_body … will result in fake false").
 * Registration is API-managed: POST/GET/DELETE /webhooks (scoped to this token's API client) —
 * the only non-GET Recharge surface on the platform.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { RechargeClient } from "./client";

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

/** Recharge's documented digest: sha256(client_secret || raw_body), hex. Secret FIRST; body untouched. */
export function computeRechargeSignature(rawBody: string | Buffer, clientSecret: string): string {
  return createHash("sha256").update(clientSecret, "utf8").update(rawBody).digest("hex");
}

/**
 * Constant-time verification of `X-Recharge-Hmac-Sha256` against the documented hex digest.
 * Exactly the documented encoding — no alternate representations are accepted (a standard keyed
 * HMAC-SHA256, or a base64 digest, is rejected).
 */
export function verifyRechargeWebhookSignature(params: { rawBody: string | Buffer; signature: string | null | undefined; clientSecret: string | null | undefined }): boolean {
  const { rawBody, signature, clientSecret } = params;
  if (!signature || !clientSecret) return false;
  const provided = signature.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;
  const a = Buffer.from(computeRechargeSignature(rawBody, clientSecret));
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const RECHARGE_TOPIC_HEADER = "x-recharge-topic";

/** The topics Phase 5 subscribes to — nothing more until a concrete requirement exists. */
export const PHASE5_WEBHOOK_TOPICS = ["order/created", "order/processed", "subscription/created", "subscription/updated", "subscription/activated", "subscription/cancelled"] as const;
export type Phase5WebhookTopic = (typeof PHASE5_WEBHOOK_TOPICS)[number];

const webhookSchema = z.object({ id: z.union([z.string(), z.number()]), address: z.string(), topic: z.string() });
const webhooksListSchema = z.object({ webhooks: z.array(webhookSchema) });
const webhookOneSchema = z.object({ webhook: webhookSchema });

export type RegisteredWebhook = { id: string; address: string; topic: string };

/** Webhook subscriptions registered for THIS token's API client (read-only). */
export async function listRegisteredWebhooks(client: RechargeClient): Promise<RegisteredWebhook[]> {
  const data = await client.get("/webhooks", { schema: webhooksListSchema });
  return data.webhooks.map((w) => ({ id: String(w.id), address: w.address, topic: w.topic }));
}

export async function createWebhookSubscription(client: RechargeClient, input: { address: string; topic: string }): Promise<RegisteredWebhook> {
  const data = await client.webhookAdmin("POST", "/webhooks", { body: { address: input.address, topic: input.topic }, schema: webhookOneSchema });
  return { id: String(data.webhook.id), address: data.webhook.address, topic: data.webhook.topic };
}

export async function deleteWebhookSubscription(client: RechargeClient, id: string): Promise<void> {
  await client.webhookAdmin("DELETE", `/webhooks/${id}`);
}

/**
 * Deterministic dedupe fingerprint for a delivery. Recharge does not document a globally unique
 * delivery id, so retries of the SAME delivery (identical raw body) collapse via
 * sha256(topic + raw body); distinct updates to the same resource stay distinct events —
 * downstream processing reconciles by authoritative GET and is idempotent regardless.
 */
export function webhookDedupeKey(topic: string, rawBody: string | Buffer): string {
  return createHash("sha256").update(`${topic}\n`).update(rawBody).digest("hex");
}

/** Best-effort resource identity from a webhook payload (display/audit only — never trusted for domain writes). */
export function extractWebhookResource(topic: string, payload: unknown): { kind: "order" | "subscription" | "unknown"; externalId: string | null } {
  const p = payload as Record<string, Record<string, unknown>> | null;
  const idOf = (o: Record<string, unknown> | undefined) => {
    const v = o?.id;
    return typeof v === "number" || typeof v === "string" ? String(v) : null;
  };
  if (topic.startsWith("order/")) return { kind: "order", externalId: idOf(p?.order) };
  if (topic.startsWith("subscription/")) return { kind: "subscription", externalId: idOf(p?.subscription) };
  return { kind: "unknown", externalId: null };
}

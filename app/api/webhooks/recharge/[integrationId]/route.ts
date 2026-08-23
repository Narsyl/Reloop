/**
 * Recharge webhook receiver (Phase 5): POST /api/webhooks/recharge/{integrationId}
 *
 *   raw body captured BEFORE parsing → HMAC-SHA256 (X-Recharge-Hmac-Sha256, constant-time, keyed by
 *   this integration's API client secret) → durable IntegrationEvent (unique (integrationId,
 *   dedupeKey)) → Inngest dispatch → fast 2xx. No lifecycle work happens in this request.
 *
 * Tenancy: the organisation is resolved ONLY from the Integration row named in the URL — payload
 * contents can never steer an event into another organisation. (Reviewed raw-prisma exception:
 * webhook entry point; eslint.config.mjs.)
 *
 * Responses: 200 stored / 200 duplicate (Recharge retries must not error), 401 invalid signature,
 * 404 unknown or non-Recharge integration, 503 secret not configured.
 */
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { decryptCredentials, hasDecryptionKeyFor } from "@/lib/crypto/credentials";
import type { StoredRechargeCredentials } from "@/lib/domain/integrations/connector";
import { extractWebhookResource, RECHARGE_SIGNATURE_HEADER, RECHARGE_TOPIC_HEADER, verifyRechargeWebhookSignature, webhookDedupeKey } from "@/lib/integrations/recharge/webhooks";
import { inngest, integrationEventReceived } from "@/lib/jobs/inngest";
import { logger } from "@/lib/logging/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ integrationId: string }> }) {
  const { integrationId } = await params;
  const rawBody = await req.text(); // raw bytes first — the signature covers exactly this
  const signature = req.headers.get(RECHARGE_SIGNATURE_HEADER);
  const topic = req.headers.get(RECHARGE_TOPIC_HEADER)?.trim() || "unknown";

  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: { id: true, organizationId: true, provider: true, status: true, encryptedCredentials: true },
  });
  if (!integration || integration.provider !== "RECHARGE" || integration.status === "DISCONNECTED") {
    return NextResponse.json({ error: "unknown endpoint" }, { status: 404 });
  }

  let clientSecret: string | null = null;
  if (integration.encryptedCredentials && hasDecryptionKeyFor(integration.encryptedCredentials)) {
    try {
      clientSecret = decryptCredentials<StoredRechargeCredentials>(integration.encryptedCredentials, integration.id).clientSecret ?? null;
    } catch {
      clientSecret = null;
    }
  }
  if (!clientSecret) {
    logger.warn("webhook.secret_missing", { integrationId });
    return NextResponse.json({ error: "webhook client secret not configured" }, { status: 503 });
  }

  const signatureValid = verifyRechargeWebhookSignature({ rawBody, signature, clientSecret });
  let payload: unknown = null;
  try {
    payload = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    payload = null;
  }
  const resource = signatureValid ? extractWebhookResource(topic, payload) : { kind: "unknown" as const, externalId: null };

  if (!signatureValid) {
    // reject; keep a truncated, clearly-marked record for operator visibility (never processed)
    await prisma.integrationEvent
      .create({
        data: {
          organizationId: integration.organizationId,
          integrationId: integration.id,
          provider: "RECHARGE",
          eventType: topic,
          externalEventId: null,
          dedupeKey: webhookDedupeKey(`invalid:${topic}`, rawBody),
          payloadJson: { rejected: "invalid signature", bodyExcerpt: rawBody.slice(0, 300) },
          headersJson: { topic, signaturePresent: !!signature },
          signatureValid: false,
          status: "IGNORED",
          processedAt: new Date(),
          lastError: "invalid signature",
        },
      })
      .catch(() => undefined); // duplicate invalid deliveries are fine to drop silently
    logger.warn("webhook.invalid_signature", { integrationId, topic });
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let eventId: string;
  try {
    const event = await prisma.integrationEvent.create({
      data: {
        organizationId: integration.organizationId,
        integrationId: integration.id,
        provider: "RECHARGE",
        eventType: topic,
        externalEventId: resource.externalId,
        dedupeKey: webhookDedupeKey(topic, rawBody),
        payloadJson: (payload ?? { raw: rawBody.slice(0, 4000) }) as Prisma.InputJsonValue,
        headersJson: { topic, signaturePresent: true },
        signatureValid: true,
        status: "RECEIVED",
      },
      select: { id: true },
    });
    eventId = event.id;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      logger.info("webhook.duplicate_delivery", { integrationId, topic });
      return NextResponse.json({ ok: true, duplicate: true });
    }
    throw e;
  }

  // durable receipt is done — dispatch is best-effort here; the redelivery cron picks up stragglers
  try {
    await inngest.send(integrationEventReceived.create({ integrationEventId: eventId, organizationId: integration.organizationId, integrationId: integration.id }));
    await prisma.integrationEvent.update({ where: { id: eventId }, data: { dispatchedAt: new Date() } });
  } catch (e) {
    logger.warn("webhook.dispatch_deferred", { eventId, error: e instanceof Error ? e.message.slice(0, 120) : String(e) });
  }
  return NextResponse.json({ ok: true, eventId });
}

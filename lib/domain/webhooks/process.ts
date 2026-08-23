import "server-only";

/**
 * Webhook processing core (Phase 5).
 *
 * A webhook payload is a SIGNAL, never a source of domain truth: processing identifies the affected
 * Recharge resource, performs targeted authenticated GET(s), and feeds the result through the SAME
 * import/normalisation/recalculation code the sync uses (`upsertConnectorOrders` /
 * `upsertConnectorSubscriptions` / `recalculateJourneysForSubscriptions`). Everything is an upsert
 * keyed by provider ids, so duplicate, late or out-of-order deliveries — and overlap with the
 * incremental cron — converge on the same state. READ-ONLY against Recharge.
 */
import { Prisma } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import { recalculateJourneysForSubscriptions } from "@/lib/domain/journeys/recalc";
import { upsertConnectorOrders, upsertConnectorSubscriptions } from "@/lib/domain/sync/stages";
import { getRechargeConnectorForIntegration } from "@/lib/domain/integrations/connector";
import type { RechargeConnector } from "@/lib/integrations/recharge";
import { extractWebhookResource } from "@/lib/integrations/recharge/webhooks";
import { isRechargeError } from "@/lib/integrations/recharge/errors";
import { logger } from "@/lib/logging/logger";

type Ctx = { organizationId: string };

export type ProcessOutcome = {
  eventId: string;
  topic: string;
  outcome: "PROCESSED" | "IGNORED" | "ALREADY_PROCESSED";
  detail: string;
  /** internal subscription ids whose lifecycle was recalculated */
  recalculated: string[];
  /** planner should run for this integration afterwards */
  plannerRelevant: boolean;
};

/**
 * Process one persisted IntegrationEvent. Idempotent: an event already PROCESSED returns without
 * side effects; re-processing an event repeats upserts that change nothing.
 */
export async function processIntegrationEvent(ctx: Ctx, eventId: string, opts: { connector?: RechargeConnector; timezone: string; now?: Date } = { timezone: "Europe/London" }): Promise<ProcessOutcome> {
  const db = dbFor(ctx);
  const event = await db.integrationEvent.findUnique({ where: { id: eventId }, include: { integration: { select: { id: true, provider: true, status: true, automationMode: true } } } });
  if (!event) throw new Error("IntegrationEvent not found in this organisation.");
  if (event.status === "PROCESSED") return { eventId, topic: event.eventType, outcome: "ALREADY_PROCESSED", detail: "event already processed", recalculated: [], plannerRelevant: false };
  if (!event.signatureValid) {
    await db.integrationEvent.update({ where: { id: event.id }, data: { status: "IGNORED", processedAt: new Date(), lastError: "invalid signature — never processed" } });
    return { eventId, topic: event.eventType, outcome: "IGNORED", detail: "invalid signature", recalculated: [], plannerRelevant: false };
  }
  await db.integrationEvent.update({ where: { id: event.id }, data: { status: "PROCESSING", attemptCount: { increment: 1 } } });

  const finish = async (outcome: "PROCESSED" | "IGNORED", detail: string, recalculated: string[], plannerRelevant: boolean): Promise<ProcessOutcome> => {
    await db.integrationEvent.update({ where: { id: event.id }, data: { status: outcome, processedAt: new Date(), lastError: outcome === "IGNORED" ? detail.slice(0, 500) : null } });
    logger.info("webhook.processed", { eventId: event.id, topic: event.eventType, outcome, detail, recalculated: recalculated.length });
    return { eventId, topic: event.eventType, outcome, detail, recalculated, plannerRelevant };
  };

  try {
    const topic = event.eventType;
    const resource = extractWebhookResource(topic, event.payloadJson);
    const integrationId = event.integrationId;
    const connector = opts.connector ?? (await getRechargeConnectorForIntegration(ctx, integrationId, { correlationId: `wh_${event.id.slice(-8)}` })).connector;

    if (resource.kind === "order" && resource.externalId) {
      // authoritative order → the shared successful-order-evidence path (cycle semantics unchanged)
      let order;
      try {
        order = await connector.getOrder(resource.externalId);
      } catch (e) {
        if (isRechargeError(e) && e.kind === "NOT_FOUND") return await finish("IGNORED", `order ${resource.externalId} no longer exists in Recharge`, [], false);
        throw e;
      }
      const { externalSubscriptionIds } = await upsertConnectorOrders(ctx, integrationId, [order]);
      if (externalSubscriptionIds.length === 0) return await finish("PROCESSED", `order ${resource.externalId} (${order.status}) carries no subscription lines or is not successful — no cycle evidence`, [], false);
      // close the ordering race: order can arrive before its subscription exists internally
      const known = await db.subscription.findMany({ where: { integrationId, externalSubscriptionId: { in: externalSubscriptionIds } }, select: { id: true, externalSubscriptionId: true } });
      const knownExt = new Set(known.map((s) => s.externalSubscriptionId));
      const subscriptionIds = known.map((s) => s.id);
      for (const missing of externalSubscriptionIds.filter((x) => !knownExt.has(x))) {
        try {
          const sub = await connector.getSubscription(missing);
          const r = await upsertConnectorSubscriptions({ ...ctx, timezone: opts.timezone }, integrationId, [sub]);
          subscriptionIds.push(...r.subscriptionIds);
        } catch (e) {
          if (isRechargeError(e) && e.kind === "NOT_FOUND") logger.warn("webhook.order_subscription_missing", { eventId: event.id, externalSubscriptionId: missing });
          else throw e;
        }
      }
      if (subscriptionIds.length > 0) {
        // re-link any order lines that predated the subscription rows, then the REAL recalculation
        for (const s of await db.subscription.findMany({ where: { integrationId, externalSubscriptionId: { in: externalSubscriptionIds } }, select: { id: true, externalSubscriptionId: true } })) {
          await db.subscriptionOrder.updateMany({ where: { integrationId, externalSubscriptionId: s.externalSubscriptionId, subscriptionId: null }, data: { subscriptionId: s.id } });
        }
        await recalculateJourneysForSubscriptions(ctx, integrationId, [...new Set(subscriptionIds)], opts.now ?? new Date());
      }
      return await finish("PROCESSED", `order ${resource.externalId} (${order.status}) → ${externalSubscriptionIds.length} subscription line(s), ${subscriptionIds.length} recalculated`, [...new Set(subscriptionIds)], subscriptionIds.length > 0);
    }

    if (resource.kind === "subscription" && resource.externalId) {
      let sub;
      try {
        sub = await connector.getSubscription(resource.externalId);
      } catch (e) {
        if (isRechargeError(e) && e.kind === "NOT_FOUND") return await finish("IGNORED", `subscription ${resource.externalId} no longer exists in Recharge`, [], false);
        throw e;
      }
      const { subscriptionIds } = await upsertConnectorSubscriptions({ ...ctx, timezone: opts.timezone }, integrationId, [sub]);
      // adopt any pre-existing orphan order lines for this subscription, then recalculate it
      for (const id of subscriptionIds) {
        await db.subscriptionOrder.updateMany({ where: { integrationId, externalSubscriptionId: resource.externalId, subscriptionId: null }, data: { subscriptionId: id } });
      }
      await recalculateJourneysForSubscriptions(ctx, integrationId, subscriptionIds, opts.now ?? new Date());
      return await finish("PROCESSED", `subscription ${resource.externalId} (${sub.providerStatus}, next ${sub.nextChargeDate ?? "—"}) reconciled`, subscriptionIds, true);
    }

    return await finish("IGNORED", `unhandled topic ${topic} or missing resource id`, [], false);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.integrationEvent.update({ where: { id: event.id }, data: { status: "FAILED", lastError: message.slice(0, 900) } }).catch(() => undefined);
    logger.error("webhook.process_failed", { eventId: event.id, topic: event.eventType, error: message.slice(0, 200) });
    throw e;
  }
}

/** True when a Prisma unique violation on (integrationId, dedupeKey) — i.e. a duplicate delivery. */
export function isDuplicateEventError(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

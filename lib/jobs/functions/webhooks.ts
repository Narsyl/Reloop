import { cron } from "inngest";
import { inngest, integrationEventReceived, automationPlanRequested } from "@/lib/jobs/inngest";
import { prisma } from "@/lib/db/prisma";
import { processIntegrationEvent } from "@/lib/domain/webhooks/process";
import { logger } from "@/lib/logging/logger";

/**
 * Phase 5 — webhook processing (read-only against Recharge).
 *
 * Serialised per integration (concurrency key) so webhook processing never races itself; the shared
 * upsert/recalculation code is idempotent, so overlap with the incremental sync converges. After a
 * lifecycle-relevant reconciliation the EXISTING planner is dispatched (same debounced event the
 * sync uses) — the planner stays the only action writer, and it is idempotent.
 */
export const processWebhookEvent = inngest.createFunction(
  {
    id: "integration-event-process",
    name: "Process webhook event (targeted reconcile)",
    triggers: [integrationEventReceived],
    concurrency: [{ key: "event.data.integrationId", limit: 1 }],
    retries: 3,
  },
  async ({ event, step }) => {
    const { integrationEventId, organizationId, integrationId } = event.data;
    const outcome = await step.run("process", async () => {
      const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } });
      return processIntegrationEvent({ organizationId }, integrationEventId, { timezone: org.timezone });
    });
    if (outcome.plannerRelevant) {
      const mode = await step.run("automation-mode", async () => (await prisma.integration.findUnique({ where: { id: integrationId }, select: { automationMode: true } }))?.automationMode ?? "OFF");
      if (mode !== "OFF") {
        await step.sendEvent("dispatch-planner", automationPlanRequested.create({ integrationId, organizationId, trigger: "WEBHOOK" }));
      }
    }
    return outcome;
  },
);

/**
 * Redelivery sweep: events that were durably persisted but whose Inngest dispatch failed (or whose
 * processing died without a retry) are re-dispatched. Runs every 15 minutes; processing is
 * idempotent, so a double dispatch is harmless.
 */
export const redispatchWebhookEvents = inngest.createFunction(
  { id: "integration-event-redispatch", name: "Re-dispatch stuck webhook events", triggers: [cron("*/15 * * * *")], retries: 1 },
  async ({ step }) => {
    const stuck = await step.run("find-stuck", async () => {
      const cutoff = new Date(Date.now() - 5 * 60_000);
      const rows = await prisma.integrationEvent.findMany({
        where: { signatureValid: true, receivedAt: { lt: cutoff }, OR: [{ status: "RECEIVED" }, { status: "PROCESSING", attemptCount: { lt: 5 }, processedAt: null, receivedAt: { lt: new Date(Date.now() - 30 * 60_000) } }] },
        select: { id: true, organizationId: true, integrationId: true },
        take: 50,
        orderBy: { receivedAt: "asc" },
      });
      return rows;
    });
    for (const e of stuck) {
      await step.sendEvent(`redispatch:${e.id}`, integrationEventReceived.create({ integrationEventId: e.id, organizationId: e.organizationId, integrationId: e.integrationId }));
      logger.info("webhook.redispatched", { eventId: e.id });
    }
    return { redispatched: stuck.length };
  },
);

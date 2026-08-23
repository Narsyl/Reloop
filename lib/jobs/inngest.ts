import { Inngest, eventType } from "inngest";
import { z } from "zod";

/**
 * Inngest client + typed events — the durable execution layer (D2).
 *
 * Events carry ONLY stable internal ids. Handlers load current state from
 * Postgres and decrypt credentials inside the connector call. Postgres remains
 * the source of truth; Inngest holds execution state and retries.
 */
export const inngest = new Inngest({ id: "subscription-ops" });

/** A webhook delivery was persisted as an IntegrationEvent and needs processing. (Phase 6) */
export const integrationEventReceived = eventType("integration/event.received", {
  schema: z.object({ integrationEventId: z.string(), organizationId: z.string(), integrationId: z.string() }),
});

/** Attach (or dry-run) a planned AutomationAction. (Phase 5) */
export const automationActionExecute = eventType("automation/action.execute", {
  schema: z.object({ automationActionId: z.string(), organizationId: z.string() }),
});

/** Re-check a subscription's live actions after a lifecycle change. (Phase 8) */
export const subscriptionReconcile = eventType("subscription/reconcile", {
  schema: z.object({ subscriptionId: z.string(), organizationId: z.string(), reason: z.string() }),
});

/** Run a persisted IntegrationSync (INITIAL or INCREMENTAL). Read-only against the provider. */
export const integrationSyncRequested = eventType("integration/sync.requested", {
  schema: z.object({ syncId: z.string(), integrationId: z.string(), organizationId: z.string() }),
});

/** Program mappings changed — recalculate journeys for an integration. */
export const automationPlanRequested = eventType("automation/plan.requested", {
  schema: z.object({ integrationId: z.string(), organizationId: z.string(), trigger: z.enum(["SYNC", "MANUAL", "CRON", "TEST"]) }),
});

export const journeysRecalculateRequested = eventType("journeys/recalculate.requested", {
  schema: z.object({ organizationId: z.string(), integrationId: z.string(), reason: z.string() }),
});

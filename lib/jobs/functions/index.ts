import { cron } from "inngest";
import { inngest } from "@/lib/jobs/inngest";
import { runIntegrationSync } from "./sync";
import { recalculateJourneys } from "./recalc";
import { scheduledIncrementalSync } from "./incremental";
import { planAutomationActions, dryRunDueActions } from "./plan";
import { processWebhookEvent, redispatchWebhookEvents } from "./webhooks";

/**
 * Function registry served by /api/inngest.
 *
 * Phase 2: integration sync (read-only import) + journey recalculation.
 * Phase 3: scheduled read-only incremental sync.
 * Phase 4: action planner (after sync / on demand) + dry-run of due actions (cron). NO provider writes.
 * Phase 5: webhook event processing (targeted reconcile) + redelivery sweep. Still NO provider writes
 * beyond /webhooks subscription management.
 * Later phases add: executeAutomationAction (LIVE), verifyNearTermActions,
 * reconcileSubscription, dailyIntegrationReconcile, resendUndispatchedEvents.
 */
export const heartbeat = inngest.createFunction(
  { id: "platform-heartbeat", name: "Platform heartbeat", triggers: [cron("0 * * * *")] },
  async ({ step }) => {
    const at = await step.run("timestamp", async () => new Date().toISOString());
    return { ok: true, at };
  },
);

export const functions = [heartbeat, runIntegrationSync, recalculateJourneys, scheduledIncrementalSync, planAutomationActions, dryRunDueActions, processWebhookEvent, redispatchWebhookEvents];

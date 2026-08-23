import { cron } from "inngest";
import { inngest } from "@/lib/jobs/inngest";
import { runIntegrationSync } from "./sync";
import { recalculateJourneys } from "./recalc";
import { scheduledIncrementalSync } from "./incremental";

/**
 * Function registry served by /api/inngest.
 *
 * Phase 2: integration sync (read-only import) + journey recalculation.
 * Later phases add: processIntegrationEvent, executeAutomationAction,
 * dispatchDueActions (cron), verifyNearTermActions (cron), reconcileSubscription,
 * dailyIntegrationReconcile (cron), resendUndispatchedEvents (cron).
 */
export const heartbeat = inngest.createFunction(
  { id: "platform-heartbeat", name: "Platform heartbeat", triggers: [cron("0 * * * *")] },
  async ({ step }) => {
    const at = await step.run("timestamp", async () => new Date().toISOString());
    return { ok: true, at };
  },
);

export const functions = [heartbeat, runIntegrationSync, recalculateJourneys, scheduledIncrementalSync];

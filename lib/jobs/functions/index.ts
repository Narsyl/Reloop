import { cron } from "inngest";
import { inngest } from "@/lib/jobs/inngest";

/**
 * Function registry served by /api/inngest.
 *
 * Phase 1 ships only a heartbeat so the integration is verified end-to-end.
 * Phase 2+ add: processIntegrationEvent, executeAutomationAction, dispatchDueActions
 * (cron), verifyNearTermActions (cron), reconcileSubscription, runIntegrationSync,
 * dailyIntegrationReconcile (cron), resendUndispatchedEvents (cron).
 */
export const heartbeat = inngest.createFunction(
  { id: "platform-heartbeat", name: "Platform heartbeat", triggers: [cron("0 * * * *")] },
  async ({ step }) => {
    const at = await step.run("timestamp", async () => new Date().toISOString());
    return { ok: true, at };
  },
);

export const functions = [heartbeat];

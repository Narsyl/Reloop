import { inngest, journeysRecalculateRequested, integrationSyncRequested } from "@/lib/jobs/inngest";
import { createSyncRun, SyncAlreadyRunningError } from "@/lib/domain/sync/progress";
import { logger } from "@/lib/logging/logger";

/**
 * Program mappings changed → recalculate journeys for the integration.
 * Implemented as a RECALCULATE_JOURNEYS sync run so progress/history is visible
 * in the same place as imports. Debounced per integration: if a run is already
 * queued/running we skip (the running one will use the latest mappings when it
 * reaches the JOURNEYS stage, or the operator can request another).
 */
export const recalculateJourneys = inngest.createFunction(
  {
    id: "journeys-recalculate",
    name: "Recalculate journeys after mapping change",
    triggers: [journeysRecalculateRequested],
    concurrency: [{ key: "event.data.integrationId", limit: 1 }],
    debounce: { key: "event.data.integrationId", period: "20s" },
    retries: 2,
  },
  async ({ event, step }) => {
    const { organizationId, integrationId, reason } = event.data;
    const created = await step.run("create-run", async () => {
      try {
        const run = await createSyncRun({ organizationId }, integrationId, "RECALCULATE_JOURNEYS");
        return { syncId: run.id, skipped: false };
      } catch (e) {
        if (e instanceof SyncAlreadyRunningError) {
          logger.info("recalc.skipped_running", { organizationId, integrationId, reason, runningSyncId: e.syncId });
          return { syncId: e.syncId, skipped: true };
        }
        throw e;
      }
    });
    if (created.skipped) return { skipped: true, syncId: created.syncId };
    await step.sendEvent("dispatch-sync", integrationSyncRequested.create({ syncId: created.syncId, integrationId, organizationId }));
    return { syncId: created.syncId };
  },
);

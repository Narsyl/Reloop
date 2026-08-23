import { cron } from "inngest";
import { inngest, integrationSyncRequested } from "@/lib/jobs/inngest";
import { prisma } from "@/lib/db/prisma";
import { createSyncRun, SyncAlreadyRunningError } from "@/lib/domain/sync/progress";
import { logger } from "@/lib/logging/logger";
import { hasDecryptionKeyFor } from "@/lib/crypto/credentials";

/**
 * Temporary freshness infrastructure until webhooks (Phase 5): every 4 hours,
 * queue a READ-ONLY incremental sync for each connected integration that has
 * completed an initial import. `updatedSince` = last successful sync − 10 min
 * (overlap is harmless: everything is an upsert). Journeys recalculate
 * deterministically inside the run. Never creates actions, never writes.
 */
export const scheduledIncrementalSync = inngest.createFunction(
  { id: "integration-incremental-sync-schedule", name: "Scheduled incremental sync (read-only)", triggers: [cron("15 */4 * * *")], retries: 1 },
  async ({ step }) => {
    const integrations = await step.run("list-integrations", async () => {
      const rows = await prisma.integration.findMany({ where: { status: "CONNECTED", lastSuccessfulSyncAt: { not: null } }, select: { id: true, organizationId: true, lastSuccessfulSyncAt: true, encryptedCredentials: true } });
      // Rows whose credentials cannot be opened on this host (seed placeholders, rotated-out keys)
      // would fail at CONNECTING every slot — skip them here with a warning instead of creating runs.
      const usable = rows.filter((r) => hasDecryptionKeyFor(r.encryptedCredentials));
      for (const r of rows) if (!usable.includes(r)) logger.warn("incremental.skipped_undecryptable_credentials", { integrationId: r.id, organizationId: r.organizationId });
      return usable.map((r) => ({ id: r.id, organizationId: r.organizationId, lastSuccessfulSyncAt: r.lastSuccessfulSyncAt }));
    });
    const queued: string[] = [];
    for (const i of integrations) {
      const res = await step.run(`queue:${i.id}`, async () => {
        try {
          // step results are JSON round-tripped, so the date arrives as a string
          const last = new Date(i.lastSuccessfulSyncAt as unknown as string);
          const run = await createSyncRun({ organizationId: i.organizationId }, i.id, "INCREMENTAL", new Date(last.getTime() - 10 * 60_000));
          return { syncId: run.id, skipped: false };
        } catch (e) {
          if (e instanceof SyncAlreadyRunningError) return { syncId: e.syncId, skipped: true };
          throw e;
        }
      });
      if (!res.skipped) {
        await step.sendEvent(`dispatch:${i.id}`, integrationSyncRequested.create({ syncId: res.syncId, integrationId: i.id, organizationId: i.organizationId }));
        queued.push(res.syncId);
      } else {
        logger.info("incremental.skipped_running", { integrationId: i.id, runningSyncId: res.syncId });
      }
    }
    return { queued };
  },
);

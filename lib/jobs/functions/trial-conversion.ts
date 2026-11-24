import { cron } from "inngest";
import { inngest } from "@/lib/jobs/inngest";
import { prisma } from "@/lib/db/prisma";
import { runTrialConversionSweep } from "@/lib/domain/trial-conversion/engine";
import { logger } from "@/lib/logging/logger";

/**
 * Phase 7 — hourly trial-conversion sweep. For every funnel that is DRY_RUN or LIVE (and
 * whose integration is connected): enrol new trial subscriptions, run the due cancellation
 * checkpoints (live fetches — a cancellation at any check permanently excludes the trial),
 * and convert what is due, with the final fresh check immediately before any write.
 * Hourly is plenty: checkpoints are day-granular and the engine is idempotent by state.
 */
export const trialConversionSweep = inngest.createFunction(
  { id: "trial-conversion-sweep", name: "Trial conversion sweep", triggers: [cron("40 * * * *")], retries: 1 },
  async ({ step }) => {
    const funnels = await step.run("list-funnels", async () =>
      prisma.trialConversionFunnel.findMany({
        where: { mode: { not: "OFF" }, integration: { status: "CONNECTED" } },
        select: { id: true, organizationId: true, name: true, mode: true },
      }),
    );
    const results: { funnelId: string; ok: boolean; error?: string; converted: number; wouldConvert: number; cancelledDetected: number }[] = [];
    for (const f of funnels) {
      const r = await step.run(`sweep:${f.id}`, async () => {
        const s = await runTrialConversionSweep({ organizationId: f.organizationId }, f.id);
        // keep the step result small
        return { funnelId: f.id, ok: s.ok, error: s.error, enrolled: s.enrolled, checked: s.checked, checkErrors: s.checkErrors, cancelledDetected: s.cancelledDetected, due: s.due, converted: s.converted, wouldConvert: s.wouldConvert, postponed: s.postponed, failed: s.failed, uncertain: s.uncertain, alreadyConverted: s.alreadyConverted };
      });
      logger.info("trial.sweep", r);
      results.push(r);
    }
    return { funnels: funnels.length, results };
  },
);

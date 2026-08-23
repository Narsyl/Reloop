import { cron } from "inngest";
import { inngest, automationPlanRequested } from "@/lib/jobs/inngest";
import { prisma } from "@/lib/db/prisma";
import { planActionsForIntegration } from "@/lib/domain/actions/planner";
import { dryRunAction } from "@/lib/domain/actions/dry-run";
import { logger } from "@/lib/logging/logger";

/**
 * Phase 4 — planning + DRY_RUN only. No provider writes exist anywhere in these functions.
 *
 * planAutomationActions: runs the planner for one integration (after each sync, on demand,
 * or when DRY_RUN is switched on). Serialised per integration; debounced so a burst of syncs
 * yields one run. Idempotent regardless (DB-arbitrated keys).
 */
export const planAutomationActions = inngest.createFunction(
  {
    id: "automation-plan-actions",
    name: "Plan automation actions (dry-run phase)",
    triggers: [automationPlanRequested],
    concurrency: [{ key: "event.data.integrationId", limit: 1 }],
    debounce: { key: "event.data.integrationId", period: "20s" },
    retries: 2,
  },
  async ({ event, step }) => {
    const { organizationId, integrationId, trigger } = event.data;
    const summary = await step.run("plan", async () => {
      const s = await planActionsForIntegration({ organizationId }, integrationId, { trigger });
      // keep the step result small (decisions can be hundreds of rows)
      return { plannerRunId: s.plannerRunId, skippedReason: s.skippedReason ?? null, planned: s.planned, replanned: s.replanned, confirmed: s.confirmed, cancelled: s.cancelled, superseded: s.superseded, held: s.held, milestonesSkipped: s.milestonesSkipped.length };
    });
    logger.info("planner.job", { integrationId, ...summary });
    return summary;
  },
);

/**
 * dryRunDueActions: every 30 minutes, dry-run PLANNED actions whose executeAfter has passed and
 * that have not been dry-run since (re)planning. In LIVE mode (unreachable now) this is where the
 * real executor would be dispatched instead.
 */
export const dryRunDueActions = inngest.createFunction(
  { id: "automation-dry-run-due", name: "Dry-run due planned actions", triggers: [cron("*/30 * * * *")], retries: 1 },
  async ({ step }) => {
    const due = await step.run("list-due", async () => {
      const now = new Date();
      const rows = await prisma.automationAction.findMany({
        where: { status: "PLANNED", executeAfter: { lte: now }, integration: { status: "CONNECTED", automationMode: { not: "OFF" } }, OR: [{ lastDryRunAt: null }, { lastDryRunAt: { lt: prisma.automationAction.fields.executeAfter } }] },
        select: { id: true, organizationId: true },
        orderBy: { executeAfter: "asc" },
        take: 100,
      });
      return rows;
    });
    const results: { id: string; wouldExecute: boolean; blockingReason: string | null }[] = [];
    for (const a of due) {
      const r = await step.run(`dry-run:${a.id}`, async () => {
        const res = await dryRunAction({ organizationId: a.organizationId }, a.id);
        return { id: a.id, wouldExecute: res.wouldExecute, blockingReason: res.blockingReason };
      });
      results.push(r);
    }
    return { due: due.length, results };
  },
);

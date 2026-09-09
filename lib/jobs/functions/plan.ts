import { cron } from "inngest";
import { inngest, automationPlanRequested } from "@/lib/jobs/inngest";
import { prisma } from "@/lib/db/prisma";
import { planActionsForIntegration } from "@/lib/domain/actions/planner";
import { executeDueActions } from "@/lib/domain/actions/execute";
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
 * dryRunDueActions: every 30 minutes. For DRY_RUN integrations, dry-run PLANNED actions whose
 * executeAfter has passed and that have not been checked since (re)planning. For LIVE
 * integrations, dispatch the real executor instead; it runs its own fresh preflight per action.
 */
export const dryRunDueActions = inngest.createFunction(
  { id: "automation-dry-run-due", name: "Dry-run due planned actions", triggers: [cron("*/30 * * * *")], retries: 1 },
  async ({ step }) => {
    const due = await step.run("list-due", async () => {
      const now = new Date();
      const rows = await prisma.automationAction.findMany({
        where: { status: "PLANNED", executeAfter: { lte: now }, integration: { status: "CONNECTED", automationMode: { not: "OFF" } }, OR: [{ lastDryRunAt: null }, { lastDryRunAt: { lt: prisma.automationAction.fields.executeAfter } }] },
        select: { id: true, organizationId: true, integrationId: true, integration: { select: { automationMode: true } } },
        orderBy: { executeAfter: "asc" },
        take: 100,
      });
      return rows;
    });
    // LIVE integrations get the real executor, once per integration; it selects and
    // preflights every due action itself, so its listing ignores the recently-checked
    // filter above (a fresh dry-run must not postpone execution).
    const liveIntegrations = await step.run("list-live", async () => {
      const rows = await prisma.automationAction.findMany({
        where: { status: "PLANNED", executeAfter: { lte: new Date() }, integration: { status: "CONNECTED", automationMode: "LIVE" } },
        select: { organizationId: true, integrationId: true },
        distinct: ["integrationId"],
      });
      return rows;
    });
    const executed: { integrationId: string; attached: number; adopted: number; skipped: number; failed: number; uncertain: number }[] = [];
    for (const li of liveIntegrations) {
      const r = await step.run(`execute:${li.integrationId}`, async () => {
        const res = await executeDueActions({ organizationId: li.organizationId }, li.integrationId);
        return { integrationId: li.integrationId, attached: res.attached, adopted: res.adopted, skipped: res.skipped, failed: res.failed, uncertain: res.uncertain };
      });
      executed.push(r);
    }
    const results: { id: string; wouldExecute: boolean; blockingReason: string | null }[] = [];
    for (const a of due.filter((a) => a.integration.automationMode !== "LIVE")) {
      const r = await step.run(`dry-run:${a.id}`, async () => {
        const res = await dryRunAction({ organizationId: a.organizationId }, a.id);
        return { id: a.id, wouldExecute: res.wouldExecute, blockingReason: res.blockingReason };
      });
      results.push(r);
    }
    return { due: due.length, executed, results };
  },
);

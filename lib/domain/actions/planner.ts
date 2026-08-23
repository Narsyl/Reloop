/**
 * Action planner (Phase 4 / 4b) — decides which milestones get a PLANNED AutomationAction.
 *
 *   subscription → latest journey → programme → reward schedule → next delivery N
 *     → effective milestone(N) (mode, scope, reward item, the reward item's Shopify binding for the programme's store)
 *     → operational eligibility + scope qualification
 *     → exactly one internally-owned PLANNED action per milestone owner
 *     → targetChargeDate = the subscription's exact provider next-charge date
 *     → executeAfter    = targetChargeAt − Organization.markerLeadHours (D6)
 *
 * Never writes to the provider. Idempotent by construction:
 *   - the DB arbitrates ownership through the UNIQUE liveKey / ownerKey (create → P2002 → "already
 *     planned"); a cheap pre-check only avoids routine violations;
 *   - re-running produces no new rows; a moved target charge is updated IN PLACE (replanCount++);
 *   - live PLANNED actions that no longer qualify are CANCELLED (reason recorded) or SUPERSEDED
 *     (the milestone now awards a different reward item) through transitionAction — the only status writer.
 *   - Actions reference the physical RewardItem; the variant is resolved from the reward item's binding at
 *     dry-run/execution time, so re-binding a reward to another Shopify variant never duplicates actions.
 *
 * INITIAL_CHECKOUT milestones are never planned here (reported as INITIAL_CHECKOUT_NOT_PLANNED).
 * `persist: false` evaluates everything and returns the same decisions without writing a row.
 */
import { Prisma, type AutomationMode } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import { logActivity } from "@/lib/domain/activity/log";
import { evaluateJourneyEligibility, type IneligibilityReason } from "@/lib/domain/eligibility/evaluate";
import { qualifyForRule, type DisqualificationReason } from "@/lib/domain/eligibility/qualify";
import { loadProgramPopulation, populationCustomerName, type PopulationRow } from "@/lib/domain/eligibility/population";
import { resolveAllProgramRewards, resolveProgramRewards, type EffectiveMilestone, type MilestoneReadinessReason, type ProgramRewardView } from "@/lib/domain/rewards/resolver";
import { computeSchedule } from "./schedule";
import { liveKeyFor, ownerKeyFor } from "./keys";
import { transitionAction, type ActionCancelReason } from "./transitions";
import { logger } from "@/lib/logging/logger";

type Ctx = { organizationId: string };

export type PlannerTrigger = "SYNC" | "MANUAL" | "CRON" | "TEST";

export type PlannerDecision = {
  milestoneId: string;
  milestoneLabel: string; // "Schedule B · delivery 2 → Cup"
  programId: string;
  programName: string;
  subscriptionId: string;
  externalSubscriptionId: string;
  customerName: string;
  journeyId: string | null;
  successfulCycles: number | null;
  lifetimeDeliveries: number;
  nextChargeDate: string | null;
  outcome: "PLANNED" | "REPLANNED" | "CONFIRMED" | "HELD" | "WOULD_PLAN" | "NOT_ELIGIBLE" | "NOT_QUALIFIED" | "OWNED_BY_OTHER_JOURNEY";
  reason?: IneligibilityReason | DisqualificationReason | "ACTION_EXISTS_FOR_CUSTOMER";
  actionId?: string;
  targetChargeDate?: string;
  executeAfter?: string;
};

export type SkippedMilestone = { programId: string; programName: string; milestoneId: string; cycleNumber: number; rewardItem: string; reason: MilestoneReadinessReason };

export type PlannerSummary = {
  plannerRunId: string | null;
  integrationId: string;
  automationMode: AutomationMode;
  persisted: boolean;
  skippedReason?: "AUTOMATION_OFF" | "INTEGRATION_NOT_CONNECTED" | "NO_PLANNABLE_MILESTONES";
  programsConsidered: number;
  milestonesConsidered: number;
  milestonesSkipped: SkippedMilestone[];
  subscriptionsEvaluated: number;
  planned: number;
  replanned: number;
  confirmed: number;
  held: number;
  cancelled: number;
  superseded: number;
  cancelledActions: { actionId: string; reason: ActionCancelReason; detail?: string }[];
  supersededActions: { actionId: string; replacedBy: string | null }[];
  decisions: PlannerDecision[];
};

export function milestoneLabel(m: Pick<EffectiveMilestone, "scheduleName" | "cycleNumber" | "rewardItem">): string {
  return `${m.scheduleName} · delivery ${m.cycleNumber} → ${m.rewardItem.name}`;
}

export async function planActionsForIntegration(
  ctx: Ctx,
  integrationId: string,
  opts: { trigger: PlannerTrigger; now?: Date; persist?: boolean; triggeredById?: string | null } = { trigger: "MANUAL" },
): Promise<PlannerSummary> {
  const db = dbFor(ctx);
  const now = opts.now ?? new Date(); // planning clock (schedule maths, lastPlannedAt); tests may pin it
  const runStartedAt = new Date(); // real clock — concurrency bookkeeping only
  const persist = opts.persist !== false;

  const integrationRow = await db.integration.findUnique({ where: { id: integrationId }, select: { id: true, status: true, automationMode: true } });
  if (!integrationRow) throw new Error("Integration not found in this organisation.");
  const integration = integrationRow;
  const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true, markerLeadHours: true } });

  const summary: PlannerSummary = {
    plannerRunId: null,
    integrationId,
    automationMode: integration.automationMode,
    persisted: persist,
    programsConsidered: 0,
    milestonesConsidered: 0,
    milestonesSkipped: [],
    subscriptionsEvaluated: 0,
    planned: 0,
    replanned: 0,
    confirmed: 0,
    held: 0,
    cancelled: 0,
    superseded: 0,
    cancelledActions: [],
    supersededActions: [],
    decisions: [],
  };

  // Automation OFF: the planner does nothing at all (no planning, no cancelling).
  if (integration.status !== "CONNECTED") summary.skippedReason = "INTEGRATION_NOT_CONNECTED";
  else if (integration.automationMode === "OFF") summary.skippedReason = "AUTOMATION_OFF";

  const run = persist
    ? await db.plannerRun.create({ data: { organizationId: ctx.organizationId, integrationId, trigger: opts.trigger, automationMode: integration.automationMode, triggeredById: opts.triggeredById ?? null, startedAt: runStartedAt } })
    : null;
  summary.plannerRunId = run?.id ?? null;

  try {
    if (!summary.skippedReason) await planInner();
    if (run) await db.plannerRun.update({ where: { id: run.id }, data: { status: "COMPLETED", finishedAt: new Date(), countsJson: countsOf(summary), detailsJson: detailsOf(summary) as unknown as Prisma.InputJsonValue } });
    return summary;
  } catch (e) {
    if (run) await db.plannerRun.update({ where: { id: run.id }, data: { status: "FAILED", finishedAt: new Date(), error: String(e).slice(0, 2000), countsJson: countsOf(summary) } }).catch(() => undefined);
    throw e;
  }

  async function planInner() {
    // 1. effective milestones per programme (programmes of this store that have a schedule)
    const views = await resolveAllProgramRewards(ctx, { integrationId });
    summary.programsConsidered = views.length;
    const viewsByProgram = new Map(views.map((v) => [v.programId, v]));
    const plannable = new Map<string, EffectiveMilestone[]>();
    for (const v of views) {
      for (const m of v.milestones) {
        summary.milestonesConsidered++;
        if (m.readiness === "READY") plannable.set(v.programId, [...(plannable.get(v.programId) ?? []), m]);
        else summary.milestonesSkipped.push({ programId: v.programId, programName: v.programName, milestoneId: m.milestoneId, cycleNumber: m.cycleNumber, rewardItem: m.rewardItem.name, reason: m.readiness });
      }
    }
    if (plannable.size === 0) summary.skippedReason = "NO_PLANNABLE_MILESTONES";

    const confirmedActionIds = new Set<string>();

    // 2. evaluate each programme's population against its plannable milestones
    for (const [programId, milestones] of plannable) {
      const population = await loadProgramPopulation(ctx, programId, { integrationId });
      summary.subscriptionsEvaluated += population.rows.length;
      for (const row of population.rows) {
        const eligibility = evaluateJourneyEligibility({
          subscription: { status: row.status, mappingStatus: row.mappingStatus, nextChargeDate: row.nextChargeDate, latestJourneyId: row.latestJourneyId, automationOverride: row.automationOverride },
          journey: row.latestJourney ? { id: row.latestJourney.id, endedAt: row.latestJourney.endedAt, programId: row.latestJourney.programId } : null,
          resolvedProgramId: row.resolvedProgramId,
          integration: row.integration,
        });
        for (const m of milestones) {
          const base = decisionBase(m, row);
          if (!eligibility.eligible) {
            summary.decisions.push({ ...base, outcome: "NOT_ELIGIBLE", reason: eligibility.reason });
            continue;
          }
          const journey = row.latestJourney!;
          const qual = qualifyForRule({
            rule: { status: "READY", programId: m.programId, cycleNumber: m.cycleNumber, eligibilityScope: m.eligibilityScope },
            journey: { programId: journey.programId, successfulCycles: journey.successfulCycles },
            customerLifetimeDeliveries: row.lifetimeDeliveries,
            allowReady: true,
          });
          if (!qual.qualifies) {
            summary.decisions.push({ ...base, outcome: "NOT_QUALIFIED", reason: qual.reason });
            continue;
          }
          const binding = m.binding!; // readiness READY guarantees an active, verified reward binding for this store
          const schedule = computeSchedule({ targetChargeDate: row.nextChargeDate!, timezone: org.timezone, markerLeadHours: org.markerLeadHours, now });
          const liveKey = liveKeyFor(journey.id, m.cycleNumber, m.rewardItem.id);
          const ownerKey = ownerKeyFor({ scope: m.eligibilityScope, journeyId: journey.id, customerId: row.customerId, programId: m.programId, targetCycle: m.cycleNumber, rewardId: m.rewardItem.id });
          if (!persist) {
            const existing = await db.automationAction.findFirst({ where: { OR: [{ liveKey }, { ownerKey }] }, select: { id: true, journeyId: true } });
            summary.decisions.push({ ...base, outcome: existing ? (existing.journeyId === journey.id ? "CONFIRMED" : "OWNED_BY_OTHER_JOURNEY") : "WOULD_PLAN", actionId: existing?.id, targetChargeDate: schedule.targetChargeDate, executeAfter: schedule.executeAfter.toISOString() });
            if (existing) confirmedActionIds.add(existing.id);
            continue;
          }
          // Cheap pre-check so routine confirmations do not raise a unique violation on every run;
          // the UNIQUE liveKey / ownerKey remain the guarantee when two planners race.
          let existing = await db.automationAction.findFirst({ where: { OR: [{ liveKey }, { ownerKey }] } });
          if (!existing) {
            try {
              const created = await db.automationAction.create({
                data: {
                  organizationId: ctx.organizationId,
                  integrationId,
                  ruleId: null,
                  rewardScheduleMilestoneId: m.milestoneId,
                  programId: m.programId,
                  subscriptionId: row.subscriptionId,
                  journeyId: journey.id,
                  rewardItemId: m.rewardItem.id,
                  fulfillmentMarkerId: null,
                  type: "ADD_FULFILLMENT_MARKER",
                  source: "RULE",
                  targetCycle: m.cycleNumber,
                  status: "PLANNED",
                  liveKey,
                  ownerKey,
                  eligibilityScope: m.eligibilityScope,
                  targetChargeDate: schedule.targetChargeDate,
                  targetChargeAt: schedule.targetChargeAt,
                  executeAfter: schedule.executeAfter,
                  externalAddressId: row.externalAddressId,
                  dryRun: integration.automationMode !== "LIVE",
                  plannerRunId: run?.id ?? null,
                  lastPlannedAt: now,
                  createdById: opts.triggeredById ?? null,
                },
                select: { id: true },
              });
              confirmedActionIds.add(created.id);
              summary.planned++;
              summary.decisions.push({ ...base, outcome: "PLANNED", actionId: created.id, targetChargeDate: schedule.targetChargeDate, executeAfter: schedule.executeAfter.toISOString() });
              await logActivity(ctx, {
                actorType: "SYSTEM",
                eventType: "ACTION_PLANNED",
                entityType: "ACTION",
                entityId: created.id,
                summary: `Planned ${integration.automationMode === "LIVE" ? "" : "(dry run) "}${m.rewardItem.name} (Shopify "${binding.externalTitle}", variant ${binding.externalVariantId}) for ${base.customerName} · ${m.programName} delivery ${m.cycleNumber} · target charge ${schedule.targetChargeDate} · attach after ${schedule.executeAfter.toISOString()}`,
                metadata: { milestoneId: m.milestoneId, scheduleId: m.scheduleId, programId: m.programId, rewardItemId: m.rewardItem.id, bindingId: binding.id, externalVariantId: binding.externalVariantId, subscriptionId: row.subscriptionId, journeyId: journey.id, targetCycle: m.cycleNumber, scope: m.eligibilityScope, plannerRunId: run?.id ?? null, insideWindow: schedule.insideWindow },
              });
              continue;
            } catch (e) {
              if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
              existing = await db.automationAction.findFirst({ where: { OR: [{ liveKey }, { ownerKey }] } });
              if (!existing) {
                summary.decisions.push({ ...base, outcome: "HELD", reason: "ACTION_EXISTS" });
                continue;
              }
            }
          }
          confirmedActionIds.add(existing.id);
          if (existing.journeyId !== journey.id) {
            summary.held++;
            summary.decisions.push({ ...base, outcome: "OWNED_BY_OTHER_JOURNEY", reason: "ACTION_EXISTS_FOR_CUSTOMER", actionId: existing.id });
            continue;
          }
          if (existing.status !== "PLANNED") {
            summary.held++;
            summary.decisions.push({ ...base, outcome: "HELD", reason: "ACTION_EXISTS", actionId: existing.id });
            continue;
          }
          const targetMoved = existing.targetChargeDate !== schedule.targetChargeDate;
          if (targetMoved) {
            await db.automationAction.update({
              where: { id: existing.id },
              data: { targetChargeDate: schedule.targetChargeDate, targetChargeAt: schedule.targetChargeAt, executeAfter: schedule.executeAfter, replanCount: { increment: 1 }, lastPlannedAt: now, plannerRunId: run?.id ?? null, externalAddressId: row.externalAddressId, lastDryRunAt: null, dryRunJson: Prisma.DbNull, wouldExecute: null, blockingReason: null, rewardScheduleMilestoneId: m.milestoneId, programId: m.programId },
            });
            summary.replanned++;
            summary.decisions.push({ ...base, outcome: "REPLANNED", actionId: existing.id, targetChargeDate: schedule.targetChargeDate, executeAfter: schedule.executeAfter.toISOString() });
            await logActivity(ctx, { actorType: "SYSTEM", eventType: "ACTION_REPLANNED", entityType: "ACTION", entityId: existing.id, summary: `Replanned ${m.rewardItem.name} for ${base.customerName}: target charge ${existing.targetChargeDate ?? "—"} → ${schedule.targetChargeDate}`, metadata: { previousTargetChargeDate: existing.targetChargeDate, targetChargeDate: schedule.targetChargeDate, plannerRunId: run?.id ?? null } });
          } else {
            await db.automationAction.update({ where: { id: existing.id }, data: { lastPlannedAt: now, ...(existing.rewardScheduleMilestoneId ? {} : { rewardScheduleMilestoneId: m.milestoneId, programId: m.programId }) } });
            summary.confirmed++;
            summary.decisions.push({ ...base, outcome: "CONFIRMED", actionId: existing.id, targetChargeDate: existing.targetChargeDate ?? undefined, executeAfter: existing.executeAfter?.toISOString() });
          }
        }
      }
    }

    // 3. reconcile: live PLANNED actions of this integration that this run did NOT confirm.
    //    Concurrency guard: ignore actions created, or (re)planned by a run that started, after this run
    //    began — a parallel planner may have just created them; they are evaluated by that run, not cancelled here.
    const stale = await db.automationAction.findMany({
      where: {
        integrationId,
        status: "PLANNED",
        id: { notIn: [...confirmedActionIds] },
        createdAt: { lt: runStartedAt },
        OR: [{ plannerRunId: null }, { plannerRun: { startedAt: { lt: runStartedAt } } }],
      },
      include: {
        subscription: { select: { id: true, status: true, nextChargeDate: true, latestJourneyId: true, mappingStatus: true, customerId: true, externalSubscriptionId: true } },
        journey: { select: { id: true, programId: true, successfulCycles: true, endedAt: true } },
        milestone: { select: { id: true, scheduleId: true, cycleNumber: true, eligibilityScope: true } },
      },
    });
    for (const a of stale) {
      const verdict = await reconcileReason(a);
      if (!persist) continue;
      if (verdict.kind === "SUPERSEDED") {
        await db.$transaction((tx) => transitionAction(tx, a.id, "SUPERSEDED", { reason: "REWARD_CHANGED", detail: "milestone now awards a different reward item", supersededById: verdict.replacedBy ?? undefined }));
        summary.superseded++;
        summary.supersededActions.push({ actionId: a.id, replacedBy: verdict.replacedBy });
        await logActivity(ctx, { actorType: "SYSTEM", eventType: "ACTION_SUPERSEDED", entityType: "ACTION", entityId: a.id, summary: `Superseded planned action for ${a.subscription.externalSubscriptionId}: the milestone now awards a different reward item${verdict.replacedBy ? ` (replaced by ${verdict.replacedBy})` : ""}`, metadata: { replacedBy: verdict.replacedBy, plannerRunId: run?.id ?? null } });
      } else {
        await db.$transaction((tx) => transitionAction(tx, a.id, "CANCELLED", { reason: verdict.reason, detail: verdict.detail }));
        summary.cancelled++;
        summary.cancelledActions.push({ actionId: a.id, reason: verdict.reason, detail: verdict.detail });
        await logActivity(ctx, { actorType: "SYSTEM", eventType: "ACTION_CANCELLED", entityType: "ACTION", entityId: a.id, summary: `Cancelled planned action for ${a.subscription.externalSubscriptionId} · delivery ${a.targetCycle}: ${verdict.reason}${verdict.detail ? ` (${verdict.detail})` : ""}`, metadata: { reason: verdict.reason, detail: verdict.detail, plannerRunId: run?.id ?? null } });
      }
    }
    logger.info("planner.completed", { integrationId, plannerRunId: run?.id ?? null, persist, ...countsOf(summary) });

    async function viewFor(programId: string): Promise<ProgramRewardView> {
      const cached = viewsByProgram.get(programId);
      if (cached) return cached;
      const v = await resolveProgramRewards(ctx, programId);
      viewsByProgram.set(programId, v);
      return v;
    }

    async function reconcileReason(a: (typeof stale)[number]): Promise<{ kind: "CANCELLED"; reason: ActionCancelReason; detail?: string } | { kind: "SUPERSEDED"; replacedBy: string | null }> {
      // legacy rule-planned action (no milestone): rules are retired
      if (!a.milestone) return { kind: "CANCELLED", reason: "RULE_RETIRED", detail: "planned from a legacy rule; schedules are the configuration now" };
      const programId = a.programId ?? a.journey.programId;
      const view = await viewFor(programId);
      const em = view.milestones.find((m) => m.milestoneId === a.milestone!.id) ?? null;
      if (!em) return { kind: "CANCELLED", reason: "MILESTONE_NOT_ASSIGNED", detail: view.schedule ? `programme now on "${view.schedule.name}"` : "programme has no reward schedule" };
      if (em.readiness !== "READY") {
        const r = em.readiness;
        if (r === "SCHEDULE_NOT_READY" || r === "SCHEDULE_ARCHIVED") return { kind: "CANCELLED", reason: "SCHEDULE_NOT_READY", detail: r };
        if (r === "MILESTONE_INACTIVE") return { kind: "CANCELLED", reason: "MILESTONE_INACTIVE" };
        if (r === "PROGRAM_INACTIVE") return { kind: "CANCELLED", reason: "PROGRAM_CHANGED", detail: "programme inactive" };
        return { kind: "CANCELLED", reason: "REWARD_UNBOUND", detail: r };
      }
      if (a.rewardItemId && em.rewardItem.id !== a.rewardItemId) {
        const replacement = await db.automationAction.findFirst({ where: { journeyId: a.journeyId, targetCycle: a.targetCycle, rewardItemId: em.rewardItem.id, status: "PLANNED" }, select: { id: true } });
        return { kind: "SUPERSEDED", replacedBy: replacement?.id ?? null };
      }
      if (a.subscription.status !== "ACTIVE") return { kind: "CANCELLED", reason: "SUBSCRIPTION_NOT_ACTIVE", detail: a.subscription.status };
      if (a.subscription.mappingStatus !== "MAPPED") return { kind: "CANCELLED", reason: "MAPPING_BROKEN" };
      if (a.subscription.latestJourneyId !== a.journeyId || a.journey.endedAt) {
        const latest = a.subscription.latestJourneyId ? await db.subscriptionJourney.findUnique({ where: { id: a.subscription.latestJourneyId }, select: { programId: true } }) : null;
        return latest && latest.programId !== a.journey.programId ? { kind: "CANCELLED", reason: "PROGRAM_CHANGED" } : { kind: "CANCELLED", reason: "JOURNEY_ENDED" };
      }
      if (a.journey.successfulCycles >= a.targetCycle) return { kind: "CANCELLED", reason: "MILESTONE_PASSED", detail: `journey at delivery ${a.journey.successfulCycles}` };
      if (!a.subscription.nextChargeDate) return { kind: "CANCELLED", reason: "NO_UPCOMING_CHARGE" };
      if (em.eligibilityScope === "CUSTOMER_PROGRAM" && a.subscription.customerId) {
        const pop = await loadProgramPopulation(ctx, programId, { integrationId });
        const row = pop.rows.find((r) => r.subscriptionId === a.subscriptionId);
        if (row && row.lifetimeDeliveries + 1 > em.cycleNumber) return { kind: "CANCELLED", reason: "CUSTOMER_ALREADY_REACHED_MILESTONE", detail: `lifetime ${row.lifetimeDeliveries}` };
      }
      return { kind: "CANCELLED", reason: "NO_LONGER_QUALIFIES" };
    }
  }
}

function decisionBase(m: EffectiveMilestone, row: PopulationRow) {
  return {
    milestoneId: m.milestoneId,
    milestoneLabel: milestoneLabel(m),
    programId: m.programId,
    programName: m.programName,
    subscriptionId: row.subscriptionId,
    externalSubscriptionId: row.externalSubscriptionId,
    customerName: populationCustomerName(row),
    journeyId: row.latestJourney?.id ?? null,
    successfulCycles: row.latestJourney?.successfulCycles ?? null,
    lifetimeDeliveries: row.lifetimeDeliveries,
    nextChargeDate: row.nextChargeDate,
  };
}

function countsOf(s: PlannerSummary) {
  return {
    programsConsidered: s.programsConsidered,
    milestonesConsidered: s.milestonesConsidered,
    milestonesSkipped: s.milestonesSkipped.length,
    subscriptionsEvaluated: s.subscriptionsEvaluated,
    planned: s.planned,
    replanned: s.replanned,
    confirmed: s.confirmed,
    held: s.held,
    cancelled: s.cancelled,
    superseded: s.superseded,
    skippedReason: s.skippedReason ?? null,
  };
}

function detailsOf(s: PlannerSummary) {
  return {
    milestonesSkipped: s.milestonesSkipped,
    cancelledActions: s.cancelledActions,
    supersededActions: s.supersededActions,
    decisions: s.decisions.filter((d) => d.outcome !== "NOT_ELIGIBLE" || d.reason === "NO_UPCOMING_CHARGE").slice(0, 500),
  };
}

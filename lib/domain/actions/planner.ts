/**
 * Action planner (Phase 4) — decides which milestones get a PLANNED AutomationAction.
 *
 *   journey state + READY/ACTIVE rule + operational eligibility + rule scope
 *     → exactly one internally-owned PLANNED action per milestone owner
 *     → targetChargeDate = the subscription's exact provider next-charge date
 *     → executeAfter    = targetChargeAt − Organization.markerLeadHours (D6)
 *
 * Never writes to the provider. Idempotent by construction:
 *   - the DB arbitrates ownership through the UNIQUE liveKey / ownerKey (create → P2002 → "already
 *     planned"); there is no find-then-create anywhere in this file;
 *   - re-running produces no new rows; a moved target charge is updated IN PLACE (replanCount++);
 *   - live PLANNED actions that no longer qualify are CANCELLED (reason recorded) or SUPERSEDED
 *     (the rule's marker changed) through transitionAction — the only status writer.
 *
 * `persist: false` evaluates everything and returns the same decisions without writing a row
 * (used for previews and for proving population parity with the impact analysis).
 */
import { Prisma, type AutomationMode, type EligibilityScope } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import { logActivity } from "@/lib/domain/activity/log";
import { evaluateJourneyEligibility, type IneligibilityReason } from "@/lib/domain/eligibility/evaluate";
import { qualifyForRule, type DisqualificationReason } from "@/lib/domain/eligibility/qualify";
import { loadProgramPopulation, populationCustomerName, type PopulationRow } from "@/lib/domain/eligibility/population";
import { computeSchedule } from "./schedule";
import { liveKeyFor, ownerKeyFor } from "./keys";
import { transitionAction, type ActionCancelReason } from "./transitions";
import { logger } from "@/lib/logging/logger";

type Ctx = { organizationId: string };

export type PlannerTrigger = "SYNC" | "MANUAL" | "CRON" | "TEST";

export type PlannerDecision = {
  ruleId: string;
  ruleName: string;
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

export type PlannerSummary = {
  plannerRunId: string | null;
  integrationId: string;
  automationMode: AutomationMode;
  persisted: boolean;
  skippedReason?: "AUTOMATION_OFF" | "INTEGRATION_NOT_CONNECTED" | "NO_USABLE_RULES";
  rulesConsidered: number;
  rulesSkipped: { ruleId: string; name: string; reason: string }[];
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

export async function planActionsForIntegration(
  ctx: Ctx,
  integrationId: string,
  opts: { trigger: PlannerTrigger; now?: Date; persist?: boolean; triggeredById?: string | null } = { trigger: "MANUAL" },
): Promise<PlannerSummary> {
  const db = dbFor(ctx);
  const now = opts.now ?? new Date();
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
    rulesConsidered: 0,
    rulesSkipped: [],
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

  // Automation OFF: the planner does nothing at all (no planning, no cancelling) — the integration
  // is simply not automated. Switching to DRY_RUN later plans from current state.
  if (integration.status !== "CONNECTED") summary.skippedReason = "INTEGRATION_NOT_CONNECTED";
  else if (integration.automationMode === "OFF") summary.skippedReason = "AUTOMATION_OFF";

  const run = persist
    ? await db.plannerRun.create({ data: { organizationId: ctx.organizationId, integrationId, trigger: opts.trigger, automationMode: integration.automationMode, triggeredById: opts.triggeredById ?? null, startedAt: now } })
    : null;
  summary.plannerRunId = run?.id ?? null;

  try {
    if (!summary.skippedReason) {
      await planInner();
    }
    if (run) {
      await db.plannerRun.update({ where: { id: run.id }, data: { status: "COMPLETED", finishedAt: new Date(), countsJson: countsOf(summary), detailsJson: detailsOf(summary) as unknown as Prisma.InputJsonValue } });
    }
    return summary;
  } catch (e) {
    if (run) await db.plannerRun.update({ where: { id: run.id }, data: { status: "FAILED", finishedAt: new Date(), error: String(e).slice(0, 2000), countsJson: countsOf(summary) } }).catch(() => undefined);
    throw e;
  }

  async function planInner() {
    // 1. usable rules: READY (configuration valid) or ACTIVE (unreachable until the live phase)
    const rules = await db.automationRule.findMany({
      where: { status: { in: ["READY", "ACTIVE"] } },
      include: { program: { select: { id: true, name: true, active: true } }, fulfillmentMarker: { select: { id: true, name: true, active: true, placeholder: true, integrationId: true } } },
      orderBy: [{ programId: "asc" }, { cycleNumber: "asc" }],
    });
    summary.rulesConsidered = rules.length;
    const usable = rules.filter((r) => {
      const skip = (reason: string) => {
        summary.rulesSkipped.push({ ruleId: r.id, name: r.name, reason });
        return false;
      };
      if (r.fulfillmentMarker.integrationId !== integrationId) return skip("MARKER_OTHER_INTEGRATION");
      if (!r.program.active) return skip("PROGRAM_INACTIVE");
      if (!r.fulfillmentMarker.active) return skip("MARKER_INACTIVE");
      if (r.fulfillmentMarker.placeholder) return skip("MARKER_PLACEHOLDER"); // never executable, never planned
      if (!r.eligibilityScope) return skip("SCOPE_NOT_CHOSEN");
      return true;
    });
    if (usable.length === 0) {
      summary.skippedReason = "NO_USABLE_RULES";
    }

    const confirmedActionIds = new Set<string>();
    const byProgram = new Map<string, typeof usable>();
    for (const r of usable) byProgram.set(r.programId, [...(byProgram.get(r.programId) ?? []), r]);

    // 2. evaluate the programme population against each usable rule
    for (const [programId, programRules] of byProgram) {
      const population = await loadProgramPopulation(ctx, programId, { integrationId });
      summary.subscriptionsEvaluated += population.rows.length;
      for (const row of population.rows) {
        const eligibility = evaluateJourneyEligibility({
          subscription: { status: row.status, mappingStatus: row.mappingStatus, nextChargeDate: row.nextChargeDate, latestJourneyId: row.latestJourneyId, automationOverride: row.automationOverride },
          journey: row.latestJourney ? { id: row.latestJourney.id, endedAt: row.latestJourney.endedAt, programId: row.latestJourney.programId } : null,
          resolvedProgramId: row.resolvedProgramId,
          integration: row.integration,
        });
        for (const rule of programRules) {
          const base = decisionBase(rule, population.programName, row);
          if (!eligibility.eligible) {
            // only record inactive/cancelled subscriptions once in a while? No — keep the full picture, but
            // cancelled subscriptions dominate; record them compactly.
            summary.decisions.push({ ...base, outcome: "NOT_ELIGIBLE", reason: eligibility.reason });
            continue;
          }
          const journey = row.latestJourney!;
          const qual = qualifyForRule({
            rule: { status: rule.status, programId: rule.programId, cycleNumber: rule.cycleNumber, eligibilityScope: rule.eligibilityScope },
            journey: { programId: journey.programId, successfulCycles: journey.successfulCycles },
            customerLifetimeDeliveries: row.lifetimeDeliveries,
            allowReady: true,
          });
          if (!qual.qualifies) {
            summary.decisions.push({ ...base, outcome: "NOT_QUALIFIED", reason: qual.reason });
            continue;
          }
          // qualifies → ensure exactly one action owns this milestone
          const schedule = computeSchedule({ targetChargeDate: row.nextChargeDate!, timezone: org.timezone, markerLeadHours: org.markerLeadHours, now });
          const liveKey = liveKeyFor(journey.id, rule.cycleNumber, rule.fulfillmentMarkerId);
          const ownerKey = ownerKeyFor({ scope: rule.eligibilityScope as EligibilityScope, journeyId: journey.id, customerId: row.customerId, programId: rule.programId, targetCycle: rule.cycleNumber, fulfillmentMarkerId: rule.fulfillmentMarkerId });
          if (!persist) {
            const existing = await db.automationAction.findFirst({ where: { OR: [{ liveKey }, { ownerKey }] }, select: { id: true, journeyId: true, status: true } });
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
                ruleId: rule.id,
                subscriptionId: row.subscriptionId,
                journeyId: journey.id,
                fulfillmentMarkerId: rule.fulfillmentMarkerId,
                type: "ADD_FULFILLMENT_MARKER",
                source: "RULE",
                targetCycle: rule.cycleNumber,
                status: "PLANNED",
                liveKey,
                ownerKey,
                eligibilityScope: rule.eligibilityScope,
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
              summary: `Planned ${integration.automationMode === "LIVE" ? "" : "(dry run) "}"${rule.fulfillmentMarker.name}" for ${base.customerName} · ${population.programName} delivery ${rule.cycleNumber} · target charge ${schedule.targetChargeDate} · attach after ${schedule.executeAfter.toISOString()}`,
              metadata: { ruleId: rule.id, subscriptionId: row.subscriptionId, journeyId: journey.id, targetCycle: rule.cycleNumber, scope: rule.eligibilityScope, plannerRunId: run?.id ?? null, insideWindow: schedule.insideWindow },
            });
            continue;
            } catch (e) {
              if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
              // lost the race: the database says this milestone is already owned — by which action?
              existing = await db.automationAction.findFirst({ where: { OR: [{ liveKey }, { ownerKey }] } });
              if (!existing) {
                // raced with a concurrent cancel; extremely unlikely — leave it to the next run
                summary.decisions.push({ ...base, outcome: "HELD", reason: "ACTION_EXISTS" });
                continue;
              }
            }
          }
          {
            confirmedActionIds.add(existing.id);
            if (existing.journeyId !== journey.id) {
              // CUSTOMER_PROGRAM: another journey of the same customer already owns this milestone
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
                data: { targetChargeDate: schedule.targetChargeDate, targetChargeAt: schedule.targetChargeAt, executeAfter: schedule.executeAfter, replanCount: { increment: 1 }, lastPlannedAt: now, plannerRunId: run?.id ?? null, externalAddressId: row.externalAddressId, lastDryRunAt: null, dryRunJson: Prisma.DbNull, wouldExecute: null, blockingReason: null },
              });
              summary.replanned++;
              summary.decisions.push({ ...base, outcome: "REPLANNED", actionId: existing.id, targetChargeDate: schedule.targetChargeDate, executeAfter: schedule.executeAfter.toISOString() });
              await logActivity(ctx, {
                actorType: "SYSTEM",
                eventType: "ACTION_REPLANNED",
                entityType: "ACTION",
                entityId: existing.id,
                summary: `Replanned "${rule.fulfillmentMarker.name}" for ${base.customerName}: target charge ${existing.targetChargeDate ?? "—"} → ${schedule.targetChargeDate}`,
                metadata: { previousTargetChargeDate: existing.targetChargeDate, targetChargeDate: schedule.targetChargeDate, plannerRunId: run?.id ?? null },
              });
            } else {
              await db.automationAction.update({ where: { id: existing.id }, data: { lastPlannedAt: now } });
              summary.confirmed++;
              summary.decisions.push({ ...base, outcome: "CONFIRMED", actionId: existing.id, targetChargeDate: existing.targetChargeDate ?? undefined, executeAfter: existing.executeAfter?.toISOString() });
            }
          }
        }
      }
    }

    // 3. reconcile: live PLANNED actions of this integration that this run did NOT confirm
    const stale = await db.automationAction.findMany({
      where: { integrationId, status: "PLANNED", id: { notIn: [...confirmedActionIds] } },
      include: {
        subscription: { select: { id: true, status: true, nextChargeDate: true, latestJourneyId: true, mappingStatus: true, customerId: true, externalSubscriptionId: true } },
        journey: { select: { id: true, programId: true, successfulCycles: true, endedAt: true } },
        rule: { select: { id: true, status: true, eligibilityScope: true, fulfillmentMarkerId: true, programId: true, cycleNumber: true } },
        fulfillmentMarker: { select: { id: true, active: true, placeholder: true } },
      },
    });
    for (const a of stale) {
      const verdict = await reconcileReason(a);
      if (!persist) {
        summary.decisions.push({ ruleId: a.ruleId ?? "", ruleName: "", programId: a.journey.programId, programName: "", subscriptionId: a.subscriptionId, externalSubscriptionId: a.subscription.externalSubscriptionId, customerName: "", journeyId: a.journeyId, successfulCycles: a.journey.successfulCycles, lifetimeDeliveries: 0, nextChargeDate: a.subscription.nextChargeDate, outcome: "NOT_QUALIFIED", reason: "ACTION_EXISTS", actionId: a.id });
        continue;
      }
      if (verdict.kind === "SUPERSEDED") {
        await db.$transaction((tx) => transitionAction(tx, a.id, "SUPERSEDED", { reason: "RULE_NOT_READY", detail: "rule marker changed", supersededById: verdict.replacedBy ?? undefined }));
        summary.superseded++;
        summary.supersededActions.push({ actionId: a.id, replacedBy: verdict.replacedBy });
        await logActivity(ctx, { actorType: "SYSTEM", eventType: "ACTION_SUPERSEDED", entityType: "ACTION", entityId: a.id, summary: `Superseded planned action for ${a.subscription.externalSubscriptionId}: the rule's marker changed${verdict.replacedBy ? ` (replaced by ${verdict.replacedBy})` : ""}`, metadata: { replacedBy: verdict.replacedBy, plannerRunId: run?.id ?? null } });
      } else {
        await db.$transaction((tx) => transitionAction(tx, a.id, "CANCELLED", { reason: verdict.reason, detail: verdict.detail }));
        summary.cancelled++;
        summary.cancelledActions.push({ actionId: a.id, reason: verdict.reason, detail: verdict.detail });
        await logActivity(ctx, { actorType: "SYSTEM", eventType: "ACTION_CANCELLED", entityType: "ACTION", entityId: a.id, summary: `Cancelled planned action for ${a.subscription.externalSubscriptionId} · delivery ${a.targetCycle}: ${verdict.reason}${verdict.detail ? ` (${verdict.detail})` : ""}`, metadata: { reason: verdict.reason, detail: verdict.detail, plannerRunId: run?.id ?? null } });
      }
    }
    logger.info("planner.completed", { integrationId, plannerRunId: run?.id ?? null, persist, ...countsOf(summary) });

    async function reconcileReason(a: (typeof stale)[number]): Promise<{ kind: "CANCELLED"; reason: ActionCancelReason; detail?: string } | { kind: "SUPERSEDED"; replacedBy: string | null }> {
      const rule = a.rule;
      if (!rule || (rule.status !== "READY" && rule.status !== "ACTIVE")) return { kind: "CANCELLED", reason: "RULE_NOT_READY" };
      if (!rule.eligibilityScope) return { kind: "CANCELLED", reason: "RULE_NOT_READY", detail: "scope not chosen" };
      if (rule.fulfillmentMarkerId !== a.fulfillmentMarkerId) {
        const replacement = await db.automationAction.findFirst({ where: { journeyId: a.journeyId, targetCycle: a.targetCycle, fulfillmentMarkerId: rule.fulfillmentMarkerId, status: "PLANNED" }, select: { id: true } });
        return { kind: "SUPERSEDED", replacedBy: replacement?.id ?? null };
      }
      if (!a.fulfillmentMarker.active || a.fulfillmentMarker.placeholder) return { kind: "CANCELLED", reason: "MARKER_UNAVAILABLE" };
      if (a.subscription.status !== "ACTIVE") return { kind: "CANCELLED", reason: "SUBSCRIPTION_NOT_ACTIVE", detail: a.subscription.status };
      if (a.subscription.mappingStatus !== "MAPPED") return { kind: "CANCELLED", reason: "MAPPING_BROKEN" };
      if (a.subscription.latestJourneyId !== a.journeyId || a.journey.endedAt) {
        const latest = a.subscription.latestJourneyId ? await db.subscriptionJourney.findUnique({ where: { id: a.subscription.latestJourneyId }, select: { programId: true } }) : null;
        return latest && latest.programId !== a.journey.programId ? { kind: "CANCELLED", reason: "PROGRAM_CHANGED" } : { kind: "CANCELLED", reason: "JOURNEY_ENDED" };
      }
      if (a.journey.successfulCycles >= a.targetCycle) return { kind: "CANCELLED", reason: "MILESTONE_PASSED", detail: `journey at delivery ${a.journey.successfulCycles}` };
      if (!a.subscription.nextChargeDate) return { kind: "CANCELLED", reason: "NO_UPCOMING_CHARGE" };
      if (rule.eligibilityScope === "CUSTOMER_PROGRAM" && a.subscription.customerId) {
        const pop = await loadProgramPopulation(ctx, rule.programId, { integrationId });
        const row = pop.rows.find((r) => r.subscriptionId === a.subscriptionId);
        if (row && row.lifetimeDeliveries + 1 > rule.cycleNumber) return { kind: "CANCELLED", reason: "CUSTOMER_ALREADY_REACHED_MILESTONE", detail: `lifetime ${row.lifetimeDeliveries}` };
      }
      return { kind: "CANCELLED", reason: "NO_LONGER_QUALIFIES" };
    }
  }
}

function decisionBase(rule: { id: string; name: string; programId: string }, programName: string, row: PopulationRow) {
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    programId: rule.programId,
    programName,
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
    rulesConsidered: s.rulesConsidered,
    rulesSkipped: s.rulesSkipped.length,
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
  // keep the run record compact: actionable decisions + rule skips + reconciliation
  return {
    rulesSkipped: s.rulesSkipped,
    cancelledActions: s.cancelledActions,
    supersededActions: s.supersededActions,
    decisions: s.decisions.filter((d) => d.outcome !== "NOT_ELIGIBLE" || d.reason === "NO_UPCOMING_CHARGE").slice(0, 500),
  };
}

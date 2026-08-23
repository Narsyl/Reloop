/**
 * Effective milestone resolution (Phase 4b).
 *
 *   SubscriptionProgram → RewardSchedule → RewardScheduleMilestone(N)
 *     → ProgramMilestoneMarker(programme, milestone) → FulfillmentMarker → readiness
 *
 * The planner consumes this instead of authored rules, so no configuration is duplicated per
 * programme. Readiness is COMPUTED, never stored: a milestone is plannable for a programme only when
 * the schedule is READY, the milestone is active and UPCOMING_RENEWAL, the programme still references
 * the milestone's schedule, a binding exists, and the bound marker is active, not a placeholder, in the
 * same organisation, and represents the milestone's reward item.
 */
import type { EligibilityScope, MilestoneExecutionMode, RewardScheduleStatus } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";

export type MilestoneReadinessReason =
  | "SCHEDULE_NOT_READY"
  | "SCHEDULE_ARCHIVED"
  | "MILESTONE_INACTIVE"
  | "INITIAL_CHECKOUT_NOT_PLANNED"
  | "BINDING_MISSING"
  | "BINDING_INACTIVE"
  | "MARKER_INACTIVE"
  | "MARKER_PLACEHOLDER"
  | "MARKER_REWARD_MISMATCH"
  | "MARKER_OTHER_INTEGRATION"
  | "PROGRAM_INACTIVE";

export const MILESTONE_READINESS_LABEL: Record<MilestoneReadinessReason, string> = {
  SCHEDULE_NOT_READY: "Schedule is still a draft",
  SCHEDULE_ARCHIVED: "Schedule is archived",
  MILESTONE_INACTIVE: "Milestone is inactive",
  INITIAL_CHECKOUT_NOT_PLANNED: "First-delivery reward: part of the checkout order, not planned by the renewal planner",
  BINDING_MISSING: "No fulfilment marker bound for this programme",
  BINDING_INACTIVE: "Marker binding is inactive",
  MARKER_INACTIVE: "Bound marker is inactive",
  MARKER_PLACEHOLDER: "Bound marker is a placeholder (not executable)",
  MARKER_REWARD_MISMATCH: "Bound marker represents a different reward item",
  MARKER_OTHER_INTEGRATION: "Bound marker belongs to a different store",
  PROGRAM_INACTIVE: "Programme is inactive",
};

export type EffectiveMilestone = {
  programId: string;
  programName: string;
  programActive: boolean;
  scheduleId: string;
  scheduleName: string;
  scheduleStatus: RewardScheduleStatus;
  milestoneId: string;
  cycleNumber: number;
  executionMode: MilestoneExecutionMode;
  eligibilityScope: EligibilityScope;
  milestoneActive: boolean;
  rewardItem: { id: string; name: string };
  binding: { id: string; active: boolean } | null;
  marker: { id: string; name: string; title: string | null; sku: string | null; externalVariantId: string; integrationId: string; active: boolean; placeholder: boolean; rewardItemId: string | null } | null;
  /** READY = the renewal planner may plan this milestone for this programme */
  readiness: "READY" | MilestoneReadinessReason;
  readinessReasons: MilestoneReadinessReason[];
};

export type ProgramRewardView = {
  programId: string;
  programName: string;
  schedule: { id: string; name: string; status: RewardScheduleStatus } | null;
  milestones: EffectiveMilestone[];
};

/** Programme integrations are derived from its mapped products (a programme normally maps one store). */
async function programIntegrationIds(db: ReturnType<typeof dbFor>, programId: string): Promise<Set<string>> {
  const rows = await db.subscriptionProgramProduct.findMany({ where: { programId }, select: { product: { select: { integrationId: true } } } });
  return new Set(rows.map((r) => r.product.integrationId));
}

export async function resolveProgramRewards(ctx: { organizationId: string }, programId: string): Promise<ProgramRewardView> {
  const db = dbFor(ctx);
  const program = await db.subscriptionProgram.findUniqueOrThrow({
    where: { id: programId },
    include: {
      rewardSchedule: { include: { milestones: { include: { rewardItem: true }, orderBy: { cycleNumber: "asc" } } } },
      milestoneMarkers: { include: { fulfillmentMarker: { select: { id: true, name: true, title: true, sku: true, externalVariantId: true, integrationId: true, active: true, placeholder: true, rewardItemId: true } } } },
    },
  });
  if (!program.rewardSchedule) return { programId, programName: program.name, schedule: null, milestones: [] };
  const integrations = await programIntegrationIds(db, programId);
  const schedule = program.rewardSchedule;
  const milestones: EffectiveMilestone[] = schedule.milestones.map((m) => {
    const binding = program.milestoneMarkers.find((b) => b.rewardScheduleMilestoneId === m.id) ?? null;
    const marker = binding?.fulfillmentMarker ?? null;
    const reasons: MilestoneReadinessReason[] = [];
    if (!program.active) reasons.push("PROGRAM_INACTIVE");
    if (schedule.status === "ARCHIVED") reasons.push("SCHEDULE_ARCHIVED");
    else if (schedule.status !== "READY") reasons.push("SCHEDULE_NOT_READY");
    if (!m.active) reasons.push("MILESTONE_INACTIVE");
    if (m.executionMode === "INITIAL_CHECKOUT") reasons.push("INITIAL_CHECKOUT_NOT_PLANNED");
    if (!binding) reasons.push("BINDING_MISSING");
    else {
      if (!binding.active) reasons.push("BINDING_INACTIVE");
      if (marker) {
        if (!marker.active) reasons.push("MARKER_INACTIVE");
        if (marker.placeholder) reasons.push("MARKER_PLACEHOLDER");
        if (marker.rewardItemId !== m.rewardItemId) reasons.push("MARKER_REWARD_MISMATCH");
        if (integrations.size > 0 && !integrations.has(marker.integrationId)) reasons.push("MARKER_OTHER_INTEGRATION");
      }
    }
    return {
      programId,
      programName: program.name,
      programActive: program.active,
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      scheduleStatus: schedule.status,
      milestoneId: m.id,
      cycleNumber: m.cycleNumber,
      executionMode: m.executionMode,
      eligibilityScope: m.eligibilityScope,
      milestoneActive: m.active,
      rewardItem: { id: m.rewardItem.id, name: m.rewardItem.name },
      binding: binding ? { id: binding.id, active: binding.active } : null,
      marker,
      readiness: reasons[0] ?? "READY",
      readinessReasons: reasons,
    };
  });
  return { programId, programName: program.name, schedule: { id: schedule.id, name: schedule.name, status: schedule.status }, milestones };
}

/** All programmes of the organisation (optionally only those whose products belong to one integration). */
export async function resolveAllProgramRewards(ctx: { organizationId: string }, opts: { integrationId?: string } = {}): Promise<ProgramRewardView[]> {
  const db = dbFor(ctx);
  const programs = await db.subscriptionProgram.findMany({
    where: { rewardScheduleId: { not: null }, ...(opts.integrationId ? { products: { some: { product: { integrationId: opts.integrationId } } } } : {}) },
    select: { id: true },
    orderBy: { name: "asc" },
  });
  const out: ProgramRewardView[] = [];
  for (const p of programs) out.push(await resolveProgramRewards(ctx, p.id));
  return out;
}

/** Pure helper: the milestone that governs the NEXT delivery of a journey, if any. */
export function milestoneForNextDelivery(view: ProgramRewardView, successfulCycles: number): EffectiveMilestone | null {
  const next = successfulCycles + 1;
  return view.milestones.find((m) => m.cycleNumber === next) ?? null;
}

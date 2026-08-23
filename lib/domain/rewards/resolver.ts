/**
 * Effective milestone resolution (Phase 4b, revised 4c).
 *
 *   SubscriptionProgram → RewardSchedule → RewardScheduleMilestone(N) → RewardItem
 *     → RewardItemExternalBinding on the Shopify store paired with the programme's Recharge store
 *     → existing Shopify variant → readiness
 *
 * The planner consumes this instead of authored rules, so no configuration is duplicated per
 * programme and no programme-specific marker exists. Readiness is COMPUTED, never stored: a milestone
 * is plannable for a programme only when the schedule is READY, the milestone is active and
 * UPCOMING_RENEWAL, the programme is active and maps exactly one store, that store has a Shopify
 * catalogue connected, and the milestone's reward item has an active binding whose last verification
 * found no blocking issue.
 */
import type { EligibilityScope, MilestoneExecutionMode, RewardScheduleStatus } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import { bindingsForRechargeStore, type ResolvedBinding } from "./bindings";

export type MilestoneReadinessReason =
  | "SCHEDULE_NOT_READY"
  | "SCHEDULE_ARCHIVED"
  | "MILESTONE_INACTIVE"
  | "INITIAL_CHECKOUT_NOT_PLANNED"
  | "PROGRAM_INACTIVE"
  | "STORE_UNKNOWN"
  | "SHOPIFY_NOT_CONNECTED"
  | "REWARD_UNBOUND"
  | "BINDING_INACTIVE"
  | "BINDING_VARIANT_MISSING";

export const MILESTONE_READINESS_LABEL: Record<MilestoneReadinessReason, string> = {
  SCHEDULE_NOT_READY: "Schedule is still a draft",
  SCHEDULE_ARCHIVED: "Schedule is archived",
  MILESTONE_INACTIVE: "Milestone is inactive",
  INITIAL_CHECKOUT_NOT_PLANNED: "First-delivery reward: part of the checkout order, not planned by the renewal planner",
  PROGRAM_INACTIVE: "Programme is inactive",
  STORE_UNKNOWN: "Programme has no mapped products (store unknown) or spans several stores",
  SHOPIFY_NOT_CONNECTED: "No Shopify catalogue connected/paired with the programme's store",
  REWARD_UNBOUND: "Reward item is not bound to a Shopify variant yet",
  BINDING_INACTIVE: "Reward binding was removed",
  BINDING_VARIANT_MISSING: "Bound Shopify variant is missing or unavailable (re-verify / rebind)",
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
  /** the programme's execution store (Recharge) and its paired catalogue (Shopify) */
  store: { rechargeIntegrationId: string | null; shopifyIntegrationId: string | null };
  /** the reward item's binding on that catalogue — the variant the one-time will reference */
  binding: ResolvedBinding | null;
  /** READY = the renewal planner may plan this milestone for this programme */
  readiness: "READY" | MilestoneReadinessReason;
  readinessReasons: MilestoneReadinessReason[];
};

export type ProgramRewardView = {
  programId: string;
  programName: string;
  schedule: { id: string; name: string; status: RewardScheduleStatus } | null;
  store: { rechargeIntegrationId: string | null; shopifyIntegrationId: string | null };
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
    include: { rewardSchedule: { include: { milestones: { include: { rewardItem: true }, orderBy: { cycleNumber: "asc" } } } } },
  });
  const integrations = await programIntegrationIds(db, programId);
  const rechargeIntegrationId = integrations.size === 1 ? [...integrations][0] : null;
  const bindings = rechargeIntegrationId ? await bindingsForRechargeStore(ctx, rechargeIntegrationId) : { shopifyIntegrationId: null, byRewardItem: new Map<string, ResolvedBinding>() };
  const store = { rechargeIntegrationId, shopifyIntegrationId: bindings.shopifyIntegrationId };
  if (!program.rewardSchedule) return { programId, programName: program.name, schedule: null, store, milestones: [] };
  const schedule = program.rewardSchedule;
  const milestones: EffectiveMilestone[] = schedule.milestones.map((m) => {
    const binding = bindings.byRewardItem.get(m.rewardItemId) ?? null;
    const reasons: MilestoneReadinessReason[] = [];
    if (!program.active) reasons.push("PROGRAM_INACTIVE");
    if (schedule.status === "ARCHIVED") reasons.push("SCHEDULE_ARCHIVED");
    else if (schedule.status !== "READY") reasons.push("SCHEDULE_NOT_READY");
    if (!m.active) reasons.push("MILESTONE_INACTIVE");
    if (m.executionMode === "INITIAL_CHECKOUT") reasons.push("INITIAL_CHECKOUT_NOT_PLANNED");
    if (!rechargeIntegrationId) reasons.push("STORE_UNKNOWN");
    else if (!bindings.shopifyIntegrationId) reasons.push("SHOPIFY_NOT_CONNECTED");
    else if (!binding) reasons.push("REWARD_UNBOUND");
    else if (!binding.active) reasons.push("BINDING_INACTIVE");
    else if (binding.blockingIssues.length > 0) reasons.push("BINDING_VARIANT_MISSING");
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
      store,
      binding,
      readiness: reasons[0] ?? "READY",
      readinessReasons: reasons,
    };
  });
  return { programId, programName: program.name, schedule: { id: schedule.id, name: schedule.name, status: schedule.status }, store, milestones };
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

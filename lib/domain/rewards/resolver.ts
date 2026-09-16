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
  INITIAL_CHECKOUT_NOT_PLANNED: "The first delivery reward arrives with the checkout order and is never planned for a renewal",
  PROGRAM_INACTIVE: "Programme is inactive",
  STORE_UNKNOWN: "The programme has no mapped products yet or spans several stores, so its store is unknown",
  SHOPIFY_NOT_CONNECTED: "No Shopify catalogue is connected for the programme's store",
  REWARD_UNBOUND: "Reward item is not bound to a Shopify variant yet",
  BINDING_INACTIVE: "Reward binding was removed",
  BINDING_VARIANT_MISSING: "The bound Shopify variant is missing or unavailable. Verify it again or choose a different product",
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
  schedule: { id: string; name: string; status: RewardScheduleStatus; repeats: boolean } | null;
  store: { rechargeIntegrationId: string | null; shopifyIntegrationId: string | null };
  milestones: EffectiveMilestone[];
};

/** One schedule version of a programme: journeys started at or after effectiveFrom use it. */
export type ProgramRewardVersions = {
  programId: string;
  programName: string;
  store: { rechargeIntegrationId: string | null; shopifyIntegrationId: string | null };
  /** the programme's baseline view (rewardScheduleId), for journeys older than every version */
  baseline: ProgramRewardView;
  /** additional versions, ascending by effectiveFrom */
  versions: { effectiveFrom: Date; view: ProgramRewardView }[];
};

/** Pick the view whose window contains the journey's start (latest effectiveFrom <= startedAt). */
export function viewForJourneyStart(v: ProgramRewardVersions, journeyStartedAt: Date | null | undefined): ProgramRewardView {
  if (!journeyStartedAt) return v.baseline;
  let chosen = v.baseline;
  for (const ver of v.versions) if (ver.effectiveFrom.getTime() <= journeyStartedAt.getTime()) chosen = ver.view;
  return chosen;
}

/**
 * The milestone a repeating journey awards at an arbitrary delivery. Position wraps around the
 * schedule length; on laps beyond the first, an INITIAL_CHECKOUT position becomes an ordinary
 * renewal gift (only the true first box predates the subscription being visible). Returns null
 * for non repeating schedules beyond their last milestone, or when the position has no milestone.
 */
export function effectiveMilestoneForCycle(view: ProgramRewardView, cycle: number): EffectiveMilestone | null {
  if (cycle < 1 || view.milestones.length === 0) return null;
  const exact = view.milestones.find((m) => m.cycleNumber === cycle);
  if (exact) return exact;
  if (!view.schedule?.repeats) return null;
  const length = Math.max(...view.milestones.map((m) => m.cycleNumber));
  if (cycle <= length) return null; // a hole inside the first lap stays a hole on every lap
  const position = ((cycle - 1) % length) + 1;
  const base = view.milestones.find((m) => m.cycleNumber === position);
  if (!base) return null;
  const reasons = base.readinessReasons.filter((r) => r !== "INITIAL_CHECKOUT_NOT_PLANNED");
  return {
    ...base,
    cycleNumber: cycle,
    executionMode: "UPCOMING_RENEWAL",
    readiness: reasons[0] ?? "READY",
    readinessReasons: reasons,
  };
}

/** Programme integrations are derived from its mapped products (a programme normally maps one store). */
async function programIntegrationIds(db: ReturnType<typeof dbFor>, programId: string): Promise<Set<string>> {
  const rows = await db.subscriptionProgramProduct.findMany({ where: { programId }, select: { product: { select: { integrationId: true } } } });
  return new Set(rows.map((r) => r.product.integrationId));
}

type LoadedSchedule = {
  id: string;
  name: string;
  status: RewardScheduleStatus;
  repeats: boolean;
  milestones: { id: string; cycleNumber: number; executionMode: MilestoneExecutionMode; eligibilityScope: EligibilityScope; active: boolean; rewardItemId: string; rewardItem: { id: string; name: string } }[];
};

const SCHEDULE_INCLUDE = { milestones: { include: { rewardItem: true }, orderBy: { cycleNumber: "asc" as const } } };

function buildView(
  program: { id: string; name: string; active: boolean },
  schedule: LoadedSchedule | null,
  store: { rechargeIntegrationId: string | null; shopifyIntegrationId: string | null },
  bindings: { byRewardItem: Map<string, ResolvedBinding> },
): ProgramRewardView {
  if (!schedule) return { programId: program.id, programName: program.name, schedule: null, store, milestones: [] };
  const milestones: EffectiveMilestone[] = schedule.milestones.map((m) => {
    const binding = bindings.byRewardItem.get(m.rewardItemId) ?? null;
    const reasons: MilestoneReadinessReason[] = [];
    if (!program.active) reasons.push("PROGRAM_INACTIVE");
    if (schedule.status === "ARCHIVED") reasons.push("SCHEDULE_ARCHIVED");
    else if (schedule.status !== "READY") reasons.push("SCHEDULE_NOT_READY");
    if (!m.active) reasons.push("MILESTONE_INACTIVE");
    if (m.executionMode === "INITIAL_CHECKOUT") reasons.push("INITIAL_CHECKOUT_NOT_PLANNED");
    if (!store.rechargeIntegrationId) reasons.push("STORE_UNKNOWN");
    else if (!store.shopifyIntegrationId) reasons.push("SHOPIFY_NOT_CONNECTED");
    else if (!binding) reasons.push("REWARD_UNBOUND");
    else if (!binding.active) reasons.push("BINDING_INACTIVE");
    else if (binding.blockingIssues.length > 0) reasons.push("BINDING_VARIANT_MISSING");
    return {
      programId: program.id,
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
  return { programId: program.id, programName: program.name, schedule: { id: schedule.id, name: schedule.name, status: schedule.status, repeats: schedule.repeats }, store, milestones };
}

/** Every schedule version of a programme, plus its baseline, with per version readiness. */
export async function resolveProgramRewardVersions(ctx: { organizationId: string }, programId: string): Promise<ProgramRewardVersions> {
  const db = dbFor(ctx);
  const program = await db.subscriptionProgram.findUniqueOrThrow({
    where: { id: programId },
    include: {
      rewardSchedule: { include: SCHEDULE_INCLUDE },
      scheduleVersions: { orderBy: { effectiveFrom: "asc" }, include: { schedule: { include: SCHEDULE_INCLUDE } } },
    },
  });
  const integrations = await programIntegrationIds(db, programId);
  const rechargeIntegrationId = integrations.size === 1 ? [...integrations][0] : null;
  const bindings = rechargeIntegrationId ? await bindingsForRechargeStore(ctx, rechargeIntegrationId) : { shopifyIntegrationId: null, byRewardItem: new Map<string, ResolvedBinding>() };
  const store = { rechargeIntegrationId, shopifyIntegrationId: bindings.shopifyIntegrationId };
  return {
    programId,
    programName: program.name,
    store,
    baseline: buildView(program, program.rewardSchedule, store, bindings),
    versions: program.scheduleVersions.map((v) => ({ effectiveFrom: v.effectiveFrom, view: buildView(program, v.schedule, store, bindings) })),
  };
}

/**
 * The programme's effective view. Without a journey context this is what NEW subscribers get:
 * the latest version if any exist, else the baseline. With `journeyStartedAt`, the view that
 * particular journey is pinned to.
 */
export async function resolveProgramRewards(ctx: { organizationId: string }, programId: string, opts: { journeyStartedAt?: Date | null } = {}): Promise<ProgramRewardView> {
  const all = await resolveProgramRewardVersions(ctx, programId);
  if (opts.journeyStartedAt !== undefined) return viewForJourneyStart(all, opts.journeyStartedAt);
  return all.versions.length > 0 ? all.versions[all.versions.length - 1].view : all.baseline;
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

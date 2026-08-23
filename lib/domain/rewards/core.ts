/**
 * Reward configuration — domain operations (Phase 4b). Configuration only; never touches
 * subscriptions, journeys or cycles, and never writes to the provider.
 *
 * Used by the server actions (with a request context) and by operational scripts/tests (with an
 * explicit context). Every mutation is audited in the activity log.
 */
import { Prisma, type EligibilityScope, type RewardScheduleStatus } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import { logActivity } from "@/lib/domain/activity/log";

type Ctx = { organizationId: string; userId?: string | null };
type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

const actor = (ctx: Ctx) => ({ actorType: (ctx.userId ? "USER" : "SYSTEM") as "USER" | "SYSTEM", actorId: ctx.userId ?? null });

// ── Reward items ───────────────────────────────────────────────────────────

export async function upsertRewardItem(ctx: Ctx, input: { id?: string; name: string; description?: string | null; operationalDescription?: string | null; active?: boolean }): Promise<Result<{ id: string }>> {
  const db = dbFor(ctx);
  const name = input.name.trim();
  if (name.length < 2 || name.length > 60) return { ok: false, error: "Give the reward a name (2–60 characters).", fieldErrors: { name: ["2–60 characters"] } };
  try {
    if (input.id) {
      const before = await db.rewardItem.findUnique({ where: { id: input.id } });
      if (!before) return { ok: false, error: "Reward item not found." };
      const item = await db.rewardItem.update({ where: { id: input.id }, data: { name, description: input.description?.trim() || null, operationalDescription: input.operationalDescription?.trim() || null, ...(input.active === undefined ? {} : { active: input.active }) } });
      await logActivity(ctx, { ...actor(ctx), eventType: "REWARD_ITEM_UPDATED", entityType: "REWARD_ITEM", entityId: item.id, summary: `Reward item "${before.name}" updated → "${item.name}"${input.active === false ? " (deactivated)" : ""}`, metadata: { before: { name: before.name, active: before.active }, after: { name: item.name, active: item.active } } });
      return { ok: true, data: { id: item.id } };
    }
    const item = await db.rewardItem.create({ data: { organizationId: ctx.organizationId, name, description: input.description?.trim() || null, operationalDescription: input.operationalDescription?.trim() || null, createdById: ctx.userId ?? null } });
    await logActivity(ctx, { ...actor(ctx), eventType: "REWARD_ITEM_CREATED", entityType: "REWARD_ITEM", entityId: item.id, summary: `Reward item "${item.name}" created${item.operationalDescription ? ` — ${item.operationalDescription}` : ""}` });
    return { ok: true, data: { id: item.id } };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, error: "A reward item with that name already exists in this organisation." };
    throw e;
  }
}

// ── Schedules ──────────────────────────────────────────────────────────────

export async function upsertRewardSchedule(ctx: Ctx, input: { id?: string; name: string; description?: string | null }): Promise<Result<{ id: string }>> {
  const db = dbFor(ctx);
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) return { ok: false, error: "Give the schedule a name (2–80 characters).", fieldErrors: { name: ["2–80 characters"] } };
  try {
    if (input.id) {
      const before = await db.rewardSchedule.findUnique({ where: { id: input.id } });
      if (!before) return { ok: false, error: "Schedule not found." };
      if (before.status === "ARCHIVED") return { ok: false, error: "Archived schedules cannot be edited." };
      const s = await db.rewardSchedule.update({ where: { id: input.id }, data: { name, description: input.description?.trim() || null } });
      await logActivity(ctx, { ...actor(ctx), eventType: "REWARD_SCHEDULE_UPDATED", entityType: "REWARD_SCHEDULE", entityId: s.id, summary: `Reward schedule "${before.name}" updated → "${s.name}"` });
      return { ok: true, data: { id: s.id } };
    }
    const s = await db.rewardSchedule.create({ data: { organizationId: ctx.organizationId, name, description: input.description?.trim() || null, createdById: ctx.userId ?? null } });
    await logActivity(ctx, { ...actor(ctx), eventType: "REWARD_SCHEDULE_CREATED", entityType: "REWARD_SCHEDULE", entityId: s.id, summary: `Reward schedule "${s.name}" created (draft)` });
    return { ok: true, data: { id: s.id } };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, error: "A schedule with that name already exists." };
    throw e;
  }
}

export const SCHEDULE_READY_REQUIREMENTS = "A schedule can be marked Ready when it has at least one active milestone and every milestone names a reward item and an eligibility scope. Per-programme readiness (the reward items' Shopify bindings for the programme's store) is shown on the schedule and checked again by the planner.";

export async function setRewardScheduleStatus(ctx: Ctx, id: string, status: RewardScheduleStatus): Promise<Result<{ status: RewardScheduleStatus }>> {
  const db = dbFor(ctx);
  const s = await db.rewardSchedule.findUnique({ where: { id }, include: { milestones: true, programs: { select: { name: true } } } });
  if (!s) return { ok: false, error: "Schedule not found." };
  if (s.status === status) return { ok: true, data: { status } };
  if (status === "READY") {
    if (!s.milestones.some((m) => m.active)) return { ok: false, error: `The schedule has no active milestone. ${SCHEDULE_READY_REQUIREMENTS}` };
  }
  await db.rewardSchedule.update({ where: { id }, data: { status } });
  await logActivity(ctx, { ...actor(ctx), eventType: `REWARD_SCHEDULE_${status}`, entityType: "REWARD_SCHEDULE", entityId: id, summary: `Reward schedule "${s.name}" marked ${status.toLowerCase()}${s.programs.length ? ` (used by ${s.programs.map((p) => p.name).join(", ")})` : ""}`, metadata: { previous: s.status, status } });
  return { ok: true, data: { status } };
}

// ── Milestones ─────────────────────────────────────────────────────────────

export async function upsertMilestone(ctx: Ctx, input: { id?: string; scheduleId: string; cycleNumber: number; rewardItemId: string; eligibilityScope: EligibilityScope; active?: boolean; notes?: string | null }): Promise<Result<{ id: string }>> {
  const db = dbFor(ctx);
  if (!Number.isInteger(input.cycleNumber) || input.cycleNumber < 1 || input.cycleNumber > 60) return { ok: false, error: "Delivery number must be a whole number between 1 and 60.", fieldErrors: { cycleNumber: ["1–60"] } };
  const schedule = await db.rewardSchedule.findUnique({ where: { id: input.scheduleId }, select: { id: true, name: true, status: true } });
  if (!schedule) return { ok: false, error: "Schedule not found." };
  if (schedule.status === "ARCHIVED") return { ok: false, error: "Archived schedules cannot be edited." };
  const item = await db.rewardItem.findUnique({ where: { id: input.rewardItemId }, select: { id: true, name: true, active: true } });
  if (!item) return { ok: false, error: "Reward item not found." };
  if (!item.active) return { ok: false, error: `Reward item "${item.name}" is inactive.` };
  const executionMode = input.cycleNumber === 1 ? "INITIAL_CHECKOUT" : "UPCOMING_RENEWAL";
  try {
    if (input.id) {
      const before = await db.rewardScheduleMilestone.findUnique({ where: { id: input.id }, include: { rewardItem: { select: { name: true } } } });
      if (!before) return { ok: false, error: "Milestone not found." };
      const m = await db.rewardScheduleMilestone.update({ where: { id: input.id }, data: { cycleNumber: input.cycleNumber, rewardItemId: input.rewardItemId, executionMode, eligibilityScope: input.eligibilityScope, notes: input.notes?.trim() || null, ...(input.active === undefined ? {} : { active: input.active }) } });
      await logActivity(ctx, { ...actor(ctx), eventType: "REWARD_MILESTONE_UPDATED", entityType: "REWARD_SCHEDULE", entityId: schedule.id, summary: `"${schedule.name}" delivery ${before.cycleNumber} → ${before.rewardItem.name} changed to delivery ${m.cycleNumber} → ${item.name} (${executionMode}, ${input.eligibilityScope}${m.active ? "" : ", inactive"})`, metadata: { milestoneId: m.id, before: { cycleNumber: before.cycleNumber, rewardItem: before.rewardItem.name, scope: before.eligibilityScope, active: before.active }, after: { cycleNumber: m.cycleNumber, rewardItem: item.name, scope: m.eligibilityScope, active: m.active } } });
      return { ok: true, data: { id: m.id } };
    }
    const m = await db.rewardScheduleMilestone.create({ data: { organizationId: ctx.organizationId, scheduleId: schedule.id, cycleNumber: input.cycleNumber, rewardItemId: item.id, executionMode, eligibilityScope: input.eligibilityScope, notes: input.notes?.trim() || null, active: input.active ?? true } });
    await logActivity(ctx, { ...actor(ctx), eventType: "REWARD_MILESTONE_ADDED", entityType: "REWARD_SCHEDULE", entityId: schedule.id, summary: `"${schedule.name}": delivery ${m.cycleNumber} → ${item.name} (${executionMode}, ${input.eligibilityScope})`, metadata: { milestoneId: m.id } });
    return { ok: true, data: { id: m.id } };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, error: `Delivery ${input.cycleNumber} already has a milestone in this schedule.` };
    if (e instanceof Prisma.PrismaClientKnownRequestError && /cycle_mode_check/.test(String(e.message))) return { ok: false, error: "Delivery 1 must be an initial-checkout milestone and later deliveries upcoming-renewal milestones." };
    throw e;
  }
}

export async function removeMilestone(ctx: Ctx, id: string): Promise<Result> {
  const db = dbFor(ctx);
  const m = await db.rewardScheduleMilestone.findUnique({ where: { id }, include: { schedule: { select: { name: true, status: true } }, rewardItem: { select: { name: true } }, _count: { select: { actions: true } } } });
  if (!m) return { ok: false, error: "Milestone not found." };
  if (m._count.actions > 0) return { ok: false, error: "This milestone has actions planned from it; deactivate it instead of removing it." };
  await db.rewardScheduleMilestone.delete({ where: { id } });
  await logActivity(ctx, { ...actor(ctx), eventType: "REWARD_MILESTONE_REMOVED", entityType: "REWARD_SCHEDULE", entityId: m.scheduleId, summary: `"${m.schedule.name}": removed delivery ${m.cycleNumber} → ${m.rewardItem.name}` });
  return { ok: true };
}

// ── Programme assignment ───────────────────────────────────────────────────

export async function assignProgramSchedule(ctx: Ctx, input: { programId: string; scheduleId: string | null }): Promise<Result> {
  const db = dbFor(ctx);
  const program = await db.subscriptionProgram.findUnique({ where: { id: input.programId }, include: { rewardSchedule: { select: { name: true } } } });
  if (!program) return { ok: false, error: "Programme not found." };
  let scheduleName: string | null = null;
  if (input.scheduleId) {
    const s = await db.rewardSchedule.findUnique({ where: { id: input.scheduleId }, select: { id: true, name: true, status: true } });
    if (!s) return { ok: false, error: "Schedule not found." };
    if (s.status === "ARCHIVED") return { ok: false, error: "Archived schedules cannot be assigned." };
    scheduleName = s.name;
  }
  if ((program.rewardScheduleId ?? null) === input.scheduleId) return { ok: true };
  await db.subscriptionProgram.update({ where: { id: program.id }, data: { rewardScheduleId: input.scheduleId, rewardScheduleAssignedAt: input.scheduleId ? new Date() : null } });
  await logActivity(ctx, { ...actor(ctx), eventType: "PROGRAM_SCHEDULE_ASSIGNED", entityType: "PROGRAM", entityId: program.id, summary: `Programme "${program.name}" reward schedule: ${program.rewardSchedule?.name ?? "none"} → ${scheduleName ?? "none"} (lifecycle history unchanged; reward eligibility only)`, metadata: { previousScheduleId: program.rewardScheduleId, scheduleId: input.scheduleId } });
  return { ok: true };
}

// ── Legacy rule migration ──────────────────────────────────────────────────

export async function migrateRuleToMilestone(ctx: Ctx, input: { ruleId: string; milestoneId: string }): Promise<Result> {
  const db = dbFor(ctx);
  const rule = await db.automationRule.findUnique({ where: { id: input.ruleId }, include: { program: { select: { name: true } }, fulfillmentMarker: { select: { name: true } } } });
  if (!rule) return { ok: false, error: "Rule not found." };
  const m = await db.rewardScheduleMilestone.findUnique({ where: { id: input.milestoneId }, include: { schedule: { select: { name: true } }, rewardItem: { select: { name: true } } } });
  if (!m) return { ok: false, error: "Milestone not found." };
  await db.automationRule.update({ where: { id: rule.id }, data: { status: "ARCHIVED", milestoneKey: null, migratedToMilestoneId: m.id } });
  await logActivity(ctx, {
    ...actor(ctx),
    eventType: "RULE_MIGRATED_TO_SCHEDULE",
    entityType: "RULE",
    entityId: rule.id,
    summary: `Rule "${rule.name}" (${rule.program.name} · delivery ${rule.cycleNumber} → ${rule.fulfillmentMarker.name}) archived and migrated to schedule "${m.schedule.name}" · delivery ${m.cycleNumber} → ${m.rewardItem.name}. Rules are legacy; the schedule is the configuration.`,
    metadata: { ruleId: rule.id, previousStatus: rule.status, scheduleId: m.scheduleId, milestoneId: m.id },
  });
  return { ok: true };
}

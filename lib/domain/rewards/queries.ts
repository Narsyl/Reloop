import "server-only";
import { dbFor } from "@/lib/db/tenant";
import type { OrgContext } from "@/lib/auth/tenancy";
import { resolveProgramRewards, type ProgramRewardView } from "./resolver";
import { analyzeMilestoneImpact } from "@/lib/domain/rules/impact";

type Ctx = Pick<OrgContext, "organizationId">;

export async function listRewardItems(ctx: Ctx) {
  return dbFor(ctx).rewardItem.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }], include: { _count: { select: { milestones: true, markers: true } } } });
}

export async function listRewardSchedules(ctx: Ctx) {
  const db = dbFor(ctx);
  const schedules = await db.rewardSchedule.findMany({
    where: { status: { not: "ARCHIVED" } },
    orderBy: [{ status: "desc" }, { name: "asc" }],
    include: { milestones: { include: { rewardItem: { select: { name: true } } }, orderBy: { cycleNumber: "asc" } }, programs: { select: { id: true, name: true, active: true }, orderBy: { name: "asc" } } },
  });
  const archived = await db.rewardSchedule.count({ where: { status: "ARCHIVED" } });
  return { schedules, archived };
}

export type MilestoneImpactCell = { programId: string; milestoneId: string; qualifyNow: number; futureOnly: number; alreadyPast: number; alreadyReached: number; eligible: number; total: number };

export async function getRewardScheduleDetail(ctx: Ctx, id: string) {
  const db = dbFor(ctx);
  const schedule = await db.rewardSchedule.findUnique({
    where: { id },
    include: { milestones: { include: { rewardItem: true, _count: { select: { actions: true } } }, orderBy: { cycleNumber: "asc" } }, programs: { select: { id: true, name: true, active: true }, orderBy: { name: "asc" } } },
  });
  if (!schedule) return null;
  const [items, unassignedPrograms, markers, views] = await Promise.all([
    db.rewardItem.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    db.subscriptionProgram.findMany({ where: { rewardScheduleId: null, active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.fulfillmentMarker.findMany({ where: { active: true }, select: { id: true, name: true, title: true, sku: true, externalVariantId: true, placeholder: true, rewardItemId: true, integrationId: true, integration: { select: { displayName: true } } }, orderBy: { name: "asc" } }),
    Promise.all(schedule.programs.map((p) => resolveProgramRewards(ctx, p.id))),
  ]);
  return { schedule, items, unassignedPrograms, markers, views: views as ProgramRewardView[] };
}

/** Impact per (programme × milestone) under the milestone's own scope — live data, no persistence. */
export async function scheduleImpactMatrix(ctx: Ctx, views: ProgramRewardView[]): Promise<MilestoneImpactCell[]> {
  const cells: MilestoneImpactCell[] = [];
  for (const v of views) {
    for (const m of v.milestones) {
      if (m.executionMode !== "UPCOMING_RENEWAL") continue;
      const impact = await analyzeMilestoneImpact(ctx, { programId: v.programId, cycleNumber: m.cycleNumber, fulfillmentMarkerId: m.marker?.id ?? null });
      const side = m.eligibilityScope === "CUSTOMER_PROGRAM" ? impact.customerProgram : impact.perSubscription;
      cells.push({
        programId: v.programId,
        milestoneId: m.milestoneId,
        qualifyNow: side.qualifyNow,
        futureOnly: side.futureOnly,
        alreadyPast: side.alreadyPast,
        alreadyReached: m.eligibilityScope === "CUSTOMER_PROGRAM" ? impact.customerProgram.alreadyReachedViaOtherSubscription : 0,
        eligible: impact.rows.filter((r) => r.eligibility.eligible).length,
        total: impact.totalSubscriptions,
      });
    }
  }
  return cells;
}

export async function listLegacyRules(ctx: Ctx) {
  return dbFor(ctx).automationRule.findMany({
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    include: { program: { select: { id: true, name: true } }, fulfillmentMarker: { select: { id: true, name: true } } },
  });
}

export async function listProgramsWithSchedules(ctx: Ctx) {
  return dbFor(ctx).subscriptionProgram.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, active: true, rewardSchedule: { select: { id: true, name: true, status: true } } } });
}

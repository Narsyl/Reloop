"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ForbiddenError, requireRole } from "@/lib/auth/tenancy";
import type { ActionResult } from "@/lib/domain/organizations/actions";
import { assignProgramSchedule, bindProgramMarker, migrateRuleToMilestone, removeMilestone, setRewardScheduleStatus, upsertMilestone, upsertRewardItem, upsertRewardSchedule } from "./core";

async function admin() {
  try {
    return await requireRole("ADMIN");
  } catch (e) {
    if (e instanceof ForbiddenError) return null;
    throw e;
  }
}
const DENIED = { ok: false as const, error: "You need the Admin or Owner role to manage reward configuration." };
function revalidateRewards(scheduleId?: string) {
  revalidatePath("/rewards");
  if (scheduleId) revalidatePath(`/rewards/${scheduleId}`);
  revalidatePath("/products");
  revalidatePath("/upcoming");
}

const itemSchema = z.object({ id: z.string().optional(), name: z.string().trim().min(2).max(60), description: z.string().trim().max(300).optional().or(z.literal("")), operationalDescription: z.string().trim().max(200).optional().or(z.literal("")), active: z.boolean().optional() });
export async function saveRewardItem(input: unknown): Promise<ActionResult<{ id: string }>> {
  const ctx = await admin();
  if (!ctx) return DENIED;
  const parsed = itemSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Please check the form.", fieldErrors: z.flattenError(parsed.error).fieldErrors };
  const r = await upsertRewardItem(ctx, parsed.data);
  if (r.ok) revalidateRewards();
  return r;
}

const scheduleSchema = z.object({ id: z.string().optional(), name: z.string().trim().min(2).max(80), description: z.string().trim().max(300).optional().or(z.literal("")) });
export async function saveRewardSchedule(input: unknown): Promise<ActionResult<{ id: string }>> {
  const ctx = await admin();
  if (!ctx) return DENIED;
  const parsed = scheduleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Please check the form.", fieldErrors: z.flattenError(parsed.error).fieldErrors };
  const r = await upsertRewardSchedule(ctx, parsed.data);
  if (r.ok) revalidateRewards(r.data?.id);
  return r;
}

const statusSchema = z.object({ id: z.string().min(1), status: z.enum(["DRAFT", "READY", "ARCHIVED"]) });
export async function setScheduleStatus(input: unknown): Promise<ActionResult<{ status: string }>> {
  const ctx = await admin();
  if (!ctx) return DENIED;
  const parsed = statusSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const r = await setRewardScheduleStatus(ctx, parsed.data.id, parsed.data.status);
  if (r.ok) revalidateRewards(parsed.data.id);
  return r;
}

const milestoneSchema = z.object({ id: z.string().optional(), scheduleId: z.string().min(1), cycleNumber: z.coerce.number().int(), rewardItemId: z.string().min(1), eligibilityScope: z.enum(["PER_SUBSCRIPTION", "CUSTOMER_PROGRAM"]), active: z.boolean().optional(), notes: z.string().trim().max(300).optional().or(z.literal("")) });
export async function saveMilestone(input: unknown): Promise<ActionResult<{ id: string }>> {
  const ctx = await admin();
  if (!ctx) return DENIED;
  const parsed = milestoneSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Please check the form.", fieldErrors: z.flattenError(parsed.error).fieldErrors };
  const r = await upsertMilestone(ctx, parsed.data);
  if (r.ok) revalidateRewards(parsed.data.scheduleId);
  return r;
}

export async function deleteMilestone(input: unknown): Promise<ActionResult> {
  const ctx = await admin();
  if (!ctx) return DENIED;
  const parsed = z.object({ id: z.string().min(1), scheduleId: z.string().min(1) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const r = await removeMilestone(ctx, parsed.data.id);
  if (r.ok) revalidateRewards(parsed.data.scheduleId);
  return r;
}

export async function assignScheduleToProgram(input: unknown): Promise<ActionResult> {
  const ctx = await admin();
  if (!ctx) return DENIED;
  const parsed = z.object({ programId: z.string().min(1), scheduleId: z.string().min(1).nullable() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const r = await assignProgramSchedule(ctx, parsed.data);
  if (r.ok) revalidateRewards(parsed.data.scheduleId ?? undefined);
  return r;
}

export async function bindMarker(input: unknown): Promise<ActionResult<{ bindingId: string | null }>> {
  const ctx = await admin();
  if (!ctx) return DENIED;
  const parsed = z.object({ programId: z.string().min(1), milestoneId: z.string().min(1), fulfillmentMarkerId: z.string().min(1).nullable(), scheduleId: z.string().min(1) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const r = await bindProgramMarker(ctx, parsed.data);
  if (r.ok) revalidateRewards(parsed.data.scheduleId);
  return r;
}

export async function migrateLegacyRule(input: unknown): Promise<ActionResult> {
  const ctx = await admin();
  if (!ctx) return DENIED;
  const parsed = z.object({ ruleId: z.string().min(1), milestoneId: z.string().min(1) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const r = await migrateRuleToMilestone(ctx, parsed.data);
  if (r.ok) {
    revalidateRewards();
    revalidatePath("/rules");
  }
  return r;
}

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { dbFor } from "@/lib/db/tenant";
import { ForbiddenError, requireRole } from "@/lib/auth/tenancy";
import { logActivity } from "@/lib/domain/activity/log";
import type { ActionResult } from "@/lib/domain/organizations/actions";

const toggleSchema = z.object({ id: z.string().min(1), enabled: z.boolean() });

/**
 * Enable / disable a rule. Enabling is a dangerous action (future subscriptions
 * will receive markers) and is always behind a confirmation dialog in the UI.
 * Rule creation/editing arrives in Phase 4.
 */
export async function setRuleEnabled(input: unknown): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireRole("ADMIN");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: e.message };
    throw e;
  }
  const parsed = toggleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const { id, enabled } = parsed.data;
  const db = dbFor(ctx);
  const rule = await db.automationRule.findUnique({
    where: { id },
    include: { program: { select: { name: true } }, fulfillmentMarker: { select: { name: true, active: true } } },
  });
  if (!rule) return { ok: false, error: "Rule not found." };
  if (enabled && !rule.fulfillmentMarker.active) {
    return { ok: false, error: `The marker "${rule.fulfillmentMarker.name}" is inactive. Activate it before enabling this rule.` };
  }
  if (rule.enabled === enabled) return { ok: true };

  await db.automationRule.update({
    where: { id },
    data: { enabled, activatedAt: enabled ? new Date() : rule.activatedAt },
  });
  await logActivity(ctx, {
    actorType: "USER",
    actorId: ctx.userId,
    eventType: enabled ? "RULE_ENABLED" : "RULE_DISABLED",
    entityType: "RULE",
    entityId: id,
    summary: `${enabled ? "Enabled" : "Disabled"} rule "${rule.name}" (${rule.program.name}, cycle ${rule.cycleNumber} → ${rule.fulfillmentMarker.name})`,
  });
  revalidatePath("/rules");
  revalidatePath(`/rules/${id}`);
  return { ok: true };
}

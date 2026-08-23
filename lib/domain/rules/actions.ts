"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma, type RuleStatus } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import { ForbiddenError, requireRole } from "@/lib/auth/tenancy";
import { logActivity } from "@/lib/domain/activity/log";
import { CYCLE_ONE_EXPLANATION, MIN_RULE_CYCLE, milestoneKey, validateRuleConfig } from "@/lib/domain/rules/validation";
import { analyzeMilestoneImpact, type ImpactSummary } from "@/lib/domain/rules/impact";
import type { ActionResult } from "@/lib/domain/organizations/actions";

/**
 * Phase 3 rule lifecycle: DRAFT ⇄ READY, DISABLED, ARCHIVED.
 * ACTIVE is NOT reachable here — activation belongs to the Action Engine phase and
 * is refused server-side. No path in this module creates an AutomationAction.
 */

const ruleInputSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).optional().or(z.literal("")),
  programId: z.string().min(1),
  cycleNumber: z.coerce.number().int(),
  fulfillmentMarkerId: z.string().min(1),
  eligibilityScope: z.enum(["PER_SUBSCRIPTION", "CUSTOMER_PROGRAM"]).nullable().optional(),
});

async function admin() {
  try {
    return await requireRole("ADMIN");
  } catch (e) {
    if (e instanceof ForbiddenError) return null;
    throw e;
  }
}

function friendly(e: unknown): string | null {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
    const target = String((e.meta as { target?: unknown })?.target ?? "");
    if (target.includes("milestoneKey")) return "A rule already exists for this programme and delivery cycle. V1 allows one milestone rule per programme + cycle — edit or archive the existing rule instead of creating a competing one.";
    if (target.includes("name")) return "A rule with that name already exists.";
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("AutomationRule_cycleNumber_min_check")) return CYCLE_ONE_EXPLANATION;
  return null;
}

/** Create or update a rule as DRAFT (or keep READY/DISABLED if still valid). */
export async function saveRule(input: unknown): Promise<ActionResult<{ id: string; status: RuleStatus }>> {
  const ctx = await admin();
  if (!ctx) return { ok: false, error: "You need the Admin or Owner role to manage rules." };
  const parsed = ruleInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Please check the form.", fieldErrors: z.flattenError(parsed.error).fieldErrors };
  const data = parsed.data;
  if (data.cycleNumber < MIN_RULE_CYCLE) return { ok: false, error: CYCLE_ONE_EXPLANATION, fieldErrors: { cycleNumber: [CYCLE_ONE_EXPLANATION] } };

  const db = dbFor(ctx);
  const [program, marker] = await Promise.all([
    db.subscriptionProgram.findUnique({ where: { id: data.programId }, select: { id: true, name: true, active: true, products: { select: { product: { select: { integrationId: true } } } } } }),
    db.fulfillmentMarker.findUnique({ where: { id: data.fulfillmentMarkerId }, select: { id: true, name: true, active: true, integrationId: true } }),
  ]);
  if (!program) return { ok: false, error: "Programme not found." };
  if (!program.active) return { ok: false, error: "That programme is inactive." };
  if (!marker) return { ok: false, error: "Fulfilment marker not found." };
  if (!marker.active) return { ok: false, error: `The marker "${marker.name}" is inactive. Reactivate it or choose another.` };
  const programIntegrations = new Set(program.products.map((p) => p.product.integrationId));
  if (programIntegrations.size > 0 && !programIntegrations.has(marker.integrationId)) {
    return { ok: false, error: "This marker belongs to a different integration than the programme's products. A marker can only be inserted into shipments of its own store." };
  }

  const key = milestoneKey(ctx.organizationId, data.programId, data.cycleNumber);
  try {
    if (data.id) {
      const existing = await db.automationRule.findUnique({ where: { id: data.id }, select: { id: true, status: true, name: true } });
      if (!existing) return { ok: false, error: "Rule not found." };
      if (existing.status === "ACTIVE") return { ok: false, error: "Active rules cannot be edited in place. Disable it first." };
      if (existing.status === "ARCHIVED") return { ok: false, error: "Archived rules cannot be edited. Create a new rule." };
      // a READY rule that is edited falls back to DRAFT until re-validated
      const rule = await db.automationRule.update({
        where: { id: data.id },
        data: { name: data.name, description: data.description || null, programId: data.programId, cycleNumber: data.cycleNumber, fulfillmentMarkerId: data.fulfillmentMarkerId, eligibilityScope: data.eligibilityScope ?? null, milestoneKey: key, status: existing.status === "DISABLED" ? "DISABLED" : "DRAFT" },
      });
      await logActivity(ctx, { actorType: "USER", actorId: ctx.userId, eventType: "RULE_UPDATED", entityType: "RULE", entityId: rule.id, summary: `Rule "${rule.name}" updated (${program.name} · delivery ${data.cycleNumber} → ${marker.name})` });
      revalidatePath("/rules");
      revalidatePath(`/rules/${rule.id}`);
      return { ok: true, data: { id: rule.id, status: rule.status } };
    }
    const rule = await db.automationRule.create({
      data: { organizationId: ctx.organizationId, name: data.name, description: data.description || null, programId: data.programId, cycleNumber: data.cycleNumber, fulfillmentMarkerId: data.fulfillmentMarkerId, eligibilityScope: data.eligibilityScope ?? null, milestoneKey: key, status: "DRAFT", createdById: ctx.userId },
    });
    await logActivity(ctx, { actorType: "USER", actorId: ctx.userId, eventType: "RULE_CREATED", entityType: "RULE", entityId: rule.id, summary: `Rule "${rule.name}" created as draft (${program.name} · delivery ${data.cycleNumber} → ${marker.name})` });
    revalidatePath("/rules");
    return { ok: true, data: { id: rule.id, status: rule.status } };
  } catch (e) {
    const f = friendly(e);
    if (f) return { ok: false, error: f, fieldErrors: f === CYCLE_ONE_EXPLANATION ? { cycleNumber: [f] } : undefined };
    throw e;
  }
}

const statusSchema = z.object({ id: z.string().min(1), status: z.enum(["DRAFT", "READY", "DISABLED", "ARCHIVED", "ACTIVE"]) });

export async function setRuleStatus(input: unknown): Promise<ActionResult<{ status: RuleStatus }>> {
  const ctx = await admin();
  if (!ctx) return { ok: false, error: "You need the Admin or Owner role to manage rules." };
  const parsed = statusSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const { id, status } = parsed.data;
  if (status === "ACTIVE") {
    return { ok: false, error: "Activation is not available in this phase: the action engine runs in dry-run only. Ready rules are planned and dry-run against real data; nothing is attached in the subscription platform until the live phase is approved." };
  }
  const db = dbFor(ctx);
  const rule = await db.automationRule.findUnique({ where: { id }, include: { program: { select: { name: true, active: true } }, fulfillmentMarker: { select: { name: true, active: true, placeholder: true } } } });
  if (!rule) return { ok: false, error: "Rule not found." };
  if (rule.status === status) return { ok: true, data: { status } };
  if (rule.status === "ARCHIVED") return { ok: false, error: "Archived rules cannot change state." };

  if (status === "READY") {
    const issues = validateRuleConfig({ name: rule.name, programId: rule.programId, cycleNumber: rule.cycleNumber, fulfillmentMarkerId: rule.fulfillmentMarkerId, eligibilityScope: rule.eligibilityScope }).filter((i) => i.blocksReady);
    if (!rule.program.active) issues.push({ field: "programId", code: "PROGRAM_INACTIVE", message: "The programme is inactive.", blocksReady: true });
    if (!rule.fulfillmentMarker.active) issues.push({ field: "fulfillmentMarkerId", code: "MARKER_INACTIVE", message: `The marker "${rule.fulfillmentMarker.name}" is inactive.`, blocksReady: true });
    if (rule.fulfillmentMarker.placeholder) issues.push({ field: "fulfillmentMarkerId", code: "MARKER_PLACEHOLDER", message: `The marker "${rule.fulfillmentMarker.name}" is a placeholder and can never be executed — replace it with the real £0 fulfilment item before marking the rule Ready.`, blocksReady: true });
    if (issues.length) return { ok: false, error: issues.map((i) => i.message).join(" ") };
  }

  await db.automationRule.update({
    where: { id },
    data: { status, milestoneKey: status === "ARCHIVED" ? null : milestoneKey(ctx.organizationId, rule.programId, rule.cycleNumber) },
  });
  await logActivity(ctx, {
    actorType: "USER",
    actorId: ctx.userId,
    eventType: `RULE_${status}`,
    entityType: "RULE",
    entityId: id,
    summary: `Rule "${rule.name}" marked ${status.toLowerCase()} (${rule.program.name} · delivery ${rule.cycleNumber} → ${rule.fulfillmentMarker.name})`,
  });
  revalidatePath("/rules");
  revalidatePath(`/rules/${id}`);
  return { ok: true, data: { status } };
}

/** Read-only impact preview for a (programme, cycle) — usable before a rule exists. */
export async function previewMilestoneImpact(input: unknown): Promise<ActionResult<ImpactSummary>> {
  let ctx;
  try {
    ctx = await requireRole("VIEWER");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: e.message };
    throw e;
  }
  const parsed = z.object({ programId: z.string().min(1), cycleNumber: z.coerce.number().int().min(MIN_RULE_CYCLE).max(60), fulfillmentMarkerId: z.string().optional().nullable() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid request." };
  const summary = await analyzeMilestoneImpact(ctx, parsed.data);
  return { ok: true, data: summary };
}

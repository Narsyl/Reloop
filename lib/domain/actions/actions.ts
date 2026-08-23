"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ForbiddenError, requireRole } from "@/lib/auth/tenancy";
import type { ActionResult } from "@/lib/domain/organizations/actions";
import { planActionsForIntegration, type PlannerSummary } from "./planner";
import { dryRunAction, type DryRunResult } from "./dry-run";
import { setIntegrationAutomationMode } from "./mode";
import { inngest, automationPlanRequested } from "@/lib/jobs/inngest";

async function withRole(minimum: "ADMIN" | "OPERATOR") {
  try {
    return await requireRole(minimum);
  } catch (e) {
    if (e instanceof ForbiddenError) return null;
    throw e;
  }
}

const modeSchema = z.object({ integrationId: z.string().min(1), mode: z.enum(["OFF", "DRY_RUN", "LIVE"]) });

/** OFF ↔ DRY_RUN. LIVE is refused server-side in this phase. */
export async function setAutomationMode(input: unknown): Promise<ActionResult<{ mode: string }>> {
  const ctx = await withRole("ADMIN");
  if (!ctx) return { ok: false, error: "You need the Admin or Owner role to change automation mode." };
  const parsed = modeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const r = await setIntegrationAutomationMode(ctx, parsed.data.integrationId, parsed.data.mode);
  if (!r.ok) return r;
  revalidatePath("/settings/integrations");
  revalidatePath(`/settings/integrations/${parsed.data.integrationId}`);
  revalidatePath("/upcoming");
  if (r.mode === "DRY_RUN" && r.previous !== "DRY_RUN") {
    // plan from current state right away (idempotent; the sync-driven planner will keep it fresh)
    await inngest.send(automationPlanRequested.create({ integrationId: parsed.data.integrationId, organizationId: ctx.organizationId, trigger: "MANUAL" }));
  }
  return { ok: true, data: { mode: r.mode } };
}

/** Run the planner now (inline, so the operator sees the result immediately). Writes only our own rows. */
export async function runPlannerNow(integrationId: string): Promise<ActionResult<PlannerSummary>> {
  const ctx = await withRole("ADMIN");
  if (!ctx) return { ok: false, error: "You need the Admin or Owner role to run the planner." };
  const summary = await planActionsForIntegration(ctx, integrationId, { trigger: "MANUAL", triggeredById: ctx.userId });
  revalidatePath("/upcoming");
  revalidatePath(`/settings/integrations/${integrationId}`);
  return { ok: true, data: summary };
}

/** Evaluate the planner without writing anything (population parity with the impact analysis). */
export async function previewPlanner(integrationId: string): Promise<ActionResult<PlannerSummary>> {
  const ctx = await withRole("OPERATOR");
  if (!ctx) return { ok: false, error: "You need the Operator role or above." };
  const summary = await planActionsForIntegration(ctx, integrationId, { trigger: "MANUAL", persist: false });
  return { ok: true, data: summary };
}

/** Dry-run one planned action now: fresh internal + read-only external state → preview. */
export async function dryRunNow(actionId: string): Promise<ActionResult<DryRunResult>> {
  const ctx = await withRole("OPERATOR");
  if (!ctx) return { ok: false, error: "You need the Operator role or above." };
  const result = await dryRunAction(ctx, actionId);
  revalidatePath("/upcoming");
  revalidatePath(`/upcoming/${actionId}`);
  return { ok: true, data: result };
}

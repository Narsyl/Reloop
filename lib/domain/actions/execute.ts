import "server-only";

/**
 * LIVE execution — every due PLANNED action runs through the Phase 6 engine under the
 * integration's standing LIVE mode instead of a single armed authorization:
 *
 *   1. the reward's binding must already be VERIFIED for this store (never promoted here)
 *   2. the FULL fresh preflight (dry-run: internal invariants, live subscription GET,
 *      exact target-date equality, existing one-time scan) runs immediately before writing
 *   3. the action is claimed PLANNED → EXECUTING atomically; a concurrent runner loses
 *   4. exactly one POST /onetimes, never blind-retried; ambiguous outcomes reconcile by
 *      READ (adopt if found; one creation retry only after proven absence)
 *   5. ATTACHED only after an authoritative read-back matches every field
 *
 * Failures surface as exceptions in Needs attention. Blocked preflights leave the action
 * PLANNED with the fresh check persisted. Nothing here ever touches Shopify.
 */
import { dbFor } from "@/lib/db/tenant";
import { logActivity } from "@/lib/domain/activity/log";
import { getRechargeConnectorForIntegration } from "@/lib/domain/integrations/connector";
import type { RechargeConnector } from "@/lib/integrations/recharge";
import { isRechargeError } from "@/lib/integrations/recharge/errors";
import type { ConnectorOnetime } from "@/lib/integrations/types";
import { dryRunAction } from "./dry-run";
import { findOurOnetime } from "./controlled";
import { ACTION_PROPERTY, buildOnetimeBody } from "./payload";
import { logger } from "@/lib/logging/logger";

type Ctx = { organizationId: string; userId?: string | null };

export type LiveExecutionResult = {
  actionId: string;
  outcome: "ATTACHED" | "ADOPTED" | "SKIPPED" | "FAILED" | "UNCERTAIN";
  detail: string;
  externalOnetimeId: string | null;
};

export type LiveExecutionSummary = {
  ok: boolean;
  error?: string;
  due: number;
  attached: number;
  adopted: number;
  skipped: number;
  failed: number;
  uncertain: number;
  results: LiveExecutionResult[];
};

const BATCH_BOUND = 50;

/** Execute every due PLANNED action for a LIVE integration, oldest first. */
export async function executeDueActions(ctx: Ctx, integrationId: string, opts: { connector?: RechargeConnector; now?: Date; limit?: number } = {}): Promise<LiveExecutionSummary> {
  const db = dbFor(ctx);
  const now = opts.now ?? new Date();
  const summary: LiveExecutionSummary = { ok: true, due: 0, attached: 0, adopted: 0, skipped: 0, failed: 0, uncertain: 0, results: [] };

  const integration = await db.integration.findUnique({ where: { id: integrationId }, select: { id: true, status: true, automationMode: true, displayName: true } });
  if (!integration) return { ...summary, ok: false, error: "Integration not found in this organisation." };
  if (integration.status !== "CONNECTED") return { ...summary, ok: false, error: "Integration is not connected." };
  if (integration.automationMode !== "LIVE") return { ...summary, ok: false, error: "Automation is not live for this integration; nothing is executed." };

  const due = await db.automationAction.findMany({
    where: { integrationId, status: "PLANNED", executeAfter: { lte: now } },
    orderBy: [{ executeAfter: "asc" }, { targetChargeAt: "asc" }],
    take: Math.min(opts.limit ?? BATCH_BOUND, BATCH_BOUND),
    select: { id: true, rewardItemId: true },
  });
  summary.due = due.length;
  if (due.length === 0) return summary;

  const connector = opts.connector ?? (await getRechargeConnectorForIntegration(ctx, integrationId, { correlationId: `live_${now.getTime().toString(36)}` })).connector;

  for (const candidate of due) {
    const r = await executeOne(ctx, integrationId, candidate, connector, now);
    summary.results.push(r);
    if (r.outcome === "ATTACHED") summary.attached++;
    else if (r.outcome === "ADOPTED") summary.adopted++;
    else if (r.outcome === "SKIPPED") summary.skipped++;
    else if (r.outcome === "FAILED") summary.failed++;
    else summary.uncertain++;
  }

  await logActivity(ctx, {
    actorType: "SYSTEM",
    eventType: "LIVE_EXECUTION_RUN",
    entityType: "INTEGRATION",
    entityId: integrationId,
    summary: `Live run for ${integration.displayName}: ${summary.attached + summary.adopted} of ${summary.due} due gifts added${summary.adopted ? ` (${summary.adopted} adopted)` : ""}${summary.skipped ? `, ${summary.skipped} waiting on a blocked check` : ""}${summary.failed ? `, ${summary.failed} failed` : ""}${summary.uncertain ? `, ${summary.uncertain} need reconciliation` : ""}.`,
    metadata: { due: summary.due, attached: summary.attached, adopted: summary.adopted, skipped: summary.skipped, failed: summary.failed, uncertain: summary.uncertain },
  });
  return summary;
}

async function executeOne(ctx: Ctx, integrationId: string, candidate: { id: string; rewardItemId: string | null }, connector: RechargeConnector, now: Date): Promise<LiveExecutionResult> {
  const db = dbFor(ctx);
  const actionId = candidate.id;
  const skip = (detail: string): LiveExecutionResult => ({ actionId, outcome: "SKIPPED", detail, externalOnetimeId: null });

  // 1. the reward's binding must already be proven compatible for this store
  if (!candidate.rewardItemId) return skip("No reward item on the action.");
  const binding = await db.rewardItemExternalBinding.findFirst({
    where: { rewardItemId: candidate.rewardItemId, active: true, integration: { pairedIntegrationId: integrationId } },
    select: { rechargeCompatibility: true },
  });
  if (!binding) return skip("The gift has no active product link for this store.");
  if (binding.rechargeCompatibility !== "VERIFIED") return skip("The gift's product link is not verified for Recharge yet.");

  // 2. FULL fresh preflight, persisted so the queue shows the latest check
  const pre = await dryRunAction(ctx, actionId, { now, persist: true, connector });
  if (!pre.wouldExecute || !pre.target || !pre.targetChargeDate) {
    return skip(`Check blocked: ${pre.blockingReason ?? "no target"}${pre.blockingDetail ? ` (${pre.blockingDetail})` : ""}. The action stays planned.`);
  }
  const addressId = pre.external.externalAddressId;
  if (!addressId) return skip("The live address id could not be confirmed. The action stays planned.");

  // 3. atomic claim — a concurrent runner or a state change since the query loses here
  const claimed = await db.automationAction.updateMany({
    where: { id: actionId, status: "PLANNED" },
    data: { status: "EXECUTING", attemptCount: { increment: 1 }, executedVia: "LIVE_AUTOMATION" },
  });
  if (claimed.count !== 1) return skip("Another process claimed this action first.");

  // adopt path — an identical one-time already exists: no POST at all
  if (pre.operation === "ADOPT_EXISTING_ONETIME" && pre.external.existingMarkerOnetime) {
    const adoptedId = pre.external.existingMarkerOnetime.externalOnetimeId;
    await attachLive(ctx, actionId, adoptedId, pre.targetChargeDate, "adopted an existing one-time, nothing was written");
    return { actionId, outcome: "ADOPTED", detail: `Adopted existing one-time ${adoptedId}.`, externalOnetimeId: adoptedId };
  }

  // 4. exactly one POST with the same body the check previewed
  const body = buildOnetimeBody({ addressId, targetChargeDate: pre.targetChargeDate, target: { externalVariantId: pre.target.externalVariantId, externalProductId: pre.target.externalProductId, title: pre.target.title }, actionId, rewardName: pre.target.rewardItem?.name ?? null });
  let created: ConnectorOnetime | null = null;
  let uncertain = false;
  try {
    created = await connector.createOnetime(body);
  } catch (e) {
    if (isRechargeError(e) && (e.kind === "VALIDATION_ERROR" || e.kind === "PERMISSION_ERROR" || e.kind === "AUTHENTICATION_ERROR" || e.kind === "NOT_FOUND")) {
      const detail = `${e.kind}: ${e.message}`;
      await failAction(ctx, integrationId, actionId, null, `Recharge rejected the gift: ${detail}`, "WARNING");
      return { actionId, outcome: "FAILED", detail, externalOnetimeId: null };
    }
    uncertain = true; // network death / 5xx / malformed 2xx — the write MAY exist
    logger.warn("live.uncertain_write", { actionId, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
  }

  // uncertain outcome → READ reconciliation; one retry only after proven absence
  if (uncertain) {
    const found = await findOurOnetime(connector, { addressId, actionId, variantId: pre.target.externalVariantId, targetChargeDate: pre.targetChargeDate });
    if (found) {
      created = found;
    } else {
      try {
        created = await connector.createOnetime(body);
        await db.automationAction.update({ where: { id: actionId }, data: { attemptCount: { increment: 1 } } });
      } catch (e2) {
        const detail = `The write outcome is unknown after one reconciled retry (${e2 instanceof Error ? e2.message.slice(0, 150) : String(e2)}).`;
        await db.automationAction.update({ where: { id: actionId }, data: { lastError: `UNCERTAIN_WRITE: ${detail.slice(0, 800)}`, lastErrorAt: new Date() } });
        await db.exception.create({ data: { organizationId: ctx.organizationId, integrationId, actionId, severity: "CRITICAL", type: "GIFT_WRITE_UNCERTAIN", title: "A gift write needs reconciliation", description: `${detail} The action is held and nothing will retry automatically.` } });
        await logActivity(ctx, { actorType: "SYSTEM", eventType: "LIVE_EXECUTION_UNCERTAIN", entityType: "ACTION", entityId: actionId, summary: `Gift write outcome unknown; held for reconciliation. ${detail.slice(0, 200)}` });
        return { actionId, outcome: "UNCERTAIN", detail, externalOnetimeId: null };
      }
    }
  }
  if (!created) {
    return { actionId, outcome: "UNCERTAIN", detail: "No created one-time and no definite failure; held for reconciliation.", externalOnetimeId: null };
  }

  // 5. authoritative read-back — ATTACHED only when EVERY field matches
  const readback = (await connector.getOnetime(created.externalOnetimeId)) ?? created;
  const issues: string[] = [];
  if (readback.externalOnetimeId !== created.externalOnetimeId) issues.push(`readback id ${readback.externalOnetimeId} != created ${created.externalOnetimeId}`);
  if (readback.externalAddressId !== addressId) issues.push(`address ${readback.externalAddressId} != ${addressId}`);
  if (readback.nextChargeDate !== pre.targetChargeDate) issues.push(`date ${readback.nextChargeDate} != ${pre.targetChargeDate}`);
  if (readback.externalVariantId !== pre.target.externalVariantId) issues.push(`variant ${readback.externalVariantId} != ${pre.target.externalVariantId}`);
  if (pre.target.externalProductId && readback.externalProductId !== pre.target.externalProductId) issues.push(`product ${readback.externalProductId} != ${pre.target.externalProductId}`);
  if (readback.quantity !== 1) issues.push(`quantity ${readback.quantity} != 1`);
  if (Number(readback.price) !== 0) issues.push(`price ${readback.price} != 0.00`);
  if (readback.properties && !readback.properties.some((p) => p.name === ACTION_PROPERTY && p.value === actionId)) issues.push("action property missing in provider response");

  if (issues.length > 0) {
    await failAction(ctx, integrationId, actionId, created.externalOnetimeId, `One-time ${created.externalOnetimeId} exists but the read-back does not match: ${issues.join("; ")}`, "CRITICAL");
    return { actionId, outcome: "FAILED", detail: issues.join("; "), externalOnetimeId: created.externalOnetimeId };
  }

  await attachLive(ctx, actionId, created.externalOnetimeId, readback.nextChargeDate ?? pre.targetChargeDate, uncertain ? "attached after read reconciliation" : "attached after verified create and read-back");
  return { actionId, outcome: "ATTACHED", detail: "Verified by authoritative read-back.", externalOnetimeId: created.externalOnetimeId };
}

async function attachLive(ctx: Ctx, actionId: string, externalOnetimeId: string, chargeDate: string | null, how: string) {
  const db = dbFor(ctx);
  await db.automationAction.update({
    where: { id: actionId },
    data: { status: "ATTACHED", externalObjectType: "onetime", externalObjectId: externalOnetimeId, externalChargeDate: chargeDate, executedAt: new Date(), verifiedAt: new Date(), lastError: null, dryRun: false },
  });
  await logActivity(ctx, { actorType: "SYSTEM", eventType: "ACTION_ATTACHED", entityType: "ACTION", entityId: actionId, summary: `Live automation: gift added — Recharge one-time ${externalOnetimeId} on charge ${chargeDate ?? "?"} (${how}).`, metadata: { externalOnetimeId, chargeDate, how } });
}

async function failAction(ctx: Ctx, integrationId: string, actionId: string, externalOnetimeId: string | null, detail: string, severity: "WARNING" | "CRITICAL") {
  const db = dbFor(ctx);
  await db.automationAction.update({
    where: { id: actionId },
    data: { status: "FAILED", lastError: detail.slice(0, 900), lastErrorAt: new Date(), ...(externalOnetimeId ? { externalObjectType: "onetime", externalObjectId: externalOnetimeId, executedAt: new Date() } : {}) },
  });
  await db.exception.create({ data: { organizationId: ctx.organizationId, integrationId, actionId, severity, type: externalOnetimeId ? "GIFT_READBACK_MISMATCH" : "GIFT_EXECUTION_FAILED", title: externalOnetimeId ? "A gift was written but did not verify" : "A gift could not be added", description: detail.slice(0, 900) } });
  await logActivity(ctx, { actorType: "SYSTEM", eventType: "LIVE_EXECUTION_FAILED", entityType: "ACTION", entityId: actionId, summary: `Gift execution failed: ${detail.slice(0, 300)}`, metadata: { externalOnetimeId } });
}

import "server-only";

/**
 * Phase 6 — the FIRST CONTROLLED Recharge one-time write.
 *
 * LIVE automation stays refused. The only way any AutomationAction can reach POST /onetimes:
 *
 *   1. an operator ARMS exactly one action (ControlledTestAuthorization; armedKey UNIQUE =
 *      integrationId while ARMED ⇒ the database guarantees at most one armed action per integration;
 *      the authorization expires and is single-use)
 *   2. the executor re-runs the FULL fresh preflight (the dry-run: internal state, live subscription
 *      GET, exact target-date equality, existing-one-time scan) immediately before writing
 *   3. the authorization is CONSUMED and the action claimed PLANNED → EXECUTING in one transaction —
 *      a second process, or a second action, aborts
 *   4. exactly one POST /onetimes (never blind-retried); ATTACHED only after the response body
 *      validates AND an immediate authoritative read-back matches every field
 *
 * Ambiguous outcomes (network death, 5xx, malformed 2xx) leave the action EXECUTING and are resolved
 * by READ reconciliation: adopt the one-time if it exists; a creation retry is permitted only after
 * positively establishing it was not created — and even then only once.
 */
import { Prisma } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import { logActivity } from "@/lib/domain/activity/log";
import { getRechargeConnectorForIntegration } from "@/lib/domain/integrations/connector";
import type { RechargeConnector } from "@/lib/integrations/recharge";
import { isRechargeError } from "@/lib/integrations/recharge/errors";
import type { ConnectorOnetime } from "@/lib/integrations/types";
import { dryRunAction, type DryRunResult } from "./dry-run";
import { ACTION_PROPERTY, buildOnetimeBody } from "./payload";
import { logger } from "@/lib/logging/logger";

type Ctx = { organizationId: string; userId?: string | null };
type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

const AUTHORIZATION_TTL_MS = 24 * 3600_000;

// ── arming ─────────────────────────────────────────────────────────────────

/** Arm exactly ONE action for the controlled test. Refused while any other authorization is armed. */
export async function armControlledTest(ctx: Ctx, input: { actionId: string; note?: string | null }): Promise<Result<{ authorizationId: string; expiresAt: Date }>> {
  const db = dbFor(ctx);
  const action = await db.automationAction.findUnique({ where: { id: input.actionId }, select: { id: true, status: true, integrationId: true, dryRun: true, subscription: { select: { externalSubscriptionId: true } } } });
  if (!action) return { ok: false, error: "Action not found in this organisation." };
  if (action.status !== "PLANNED") return { ok: false, error: `Action is ${action.status}; only a PLANNED action can be armed.` };
  const expiresAt = new Date(Date.now() + AUTHORIZATION_TTL_MS);
  try {
    const auth = await db.controlledTestAuthorization.create({
      data: { organizationId: ctx.organizationId, integrationId: action.integrationId, actionId: action.id, status: "ARMED", armedKey: action.integrationId, armedById: ctx.userId ?? null, expiresAt, note: input.note ?? null },
      select: { id: true },
    });
    await logActivity(ctx, {
      actorType: ctx.userId ? "USER" : "SYSTEM",
      actorId: ctx.userId ?? null,
      eventType: "CONTROLLED_TEST_ARMED",
      entityType: "ACTION",
      entityId: action.id,
      summary: `Controlled-test authorization ARMED for action ${action.id} (subscription ${action.subscription.externalSubscriptionId}). Single-use, expires ${expiresAt.toISOString()}. Every other action remains unexecutable; LIVE stays refused.`,
      metadata: { authorizationId: auth.id, expiresAt: expiresAt.toISOString() },
    });
    return { ok: true, data: { authorizationId: auth.id, expiresAt } };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const existing = await db.controlledTestAuthorization.findFirst({ where: { integrationId: action.integrationId, status: "ARMED" }, select: { actionId: true, expiresAt: true } });
      return { ok: false, error: existing ? `Another action is already armed (${existing.actionId}, expires ${existing.expiresAt.toISOString()}). Disarm it first — only one controlled test can exist at a time.` : "This action already has a (consumed) authorization; it cannot be armed twice." };
    }
    throw e;
  }
}

/** Disarm without executing (also used to clear an expired authorization). */
export async function disarmControlledTest(ctx: Ctx, actionId: string): Promise<Result> {
  const db = dbFor(ctx);
  const updated = await db.controlledTestAuthorization.updateMany({ where: { actionId, status: "ARMED" }, data: { status: "CLEARED", armedKey: null, clearedAt: new Date(), outcome: "CLEARED" } });
  if (updated.count === 0) return { ok: false, error: "No armed authorization for that action." };
  await logActivity(ctx, { actorType: ctx.userId ? "USER" : "SYSTEM", actorId: ctx.userId ?? null, eventType: "CONTROLLED_TEST_DISARMED", entityType: "ACTION", entityId: actionId, summary: `Controlled-test authorization cleared for action ${actionId} without executing.` });
  return { ok: true };
}

// ── execution ──────────────────────────────────────────────────────────────

export type ControlledExecutionReport = {
  actionId: string;
  outcome: "ATTACHED" | "ADOPTED" | "FAILED" | "ABORTED_PREFLIGHT" | "UNCERTAIN";
  detail: string;
  preflight: Pick<DryRunResult, "wouldExecute" | "blockingReason" | "blockingDetail" | "operation" | "targetChargeDate" | "external" | "target"> | null;
  requestBody: Record<string, unknown> | null;
  externalOnetimeId: string | null;
  readback: ConnectorOnetime | null;
  readbackIssues: string[];
  compatibilityPromoted: boolean;
};

/**
 * Execute THE armed action. `actionId` must match the armed authorization exactly; everything else
 * is refused before any provider call.
 */
export async function executeControlledTest(ctx: Ctx, actionId: string, opts: { connector?: RechargeConnector; now?: Date } = {}): Promise<ControlledExecutionReport> {
  const db = dbFor(ctx);
  const now = opts.now ?? new Date();
  const report: ControlledExecutionReport = { actionId, outcome: "ABORTED_PREFLIGHT", detail: "", preflight: null, requestBody: null, externalOnetimeId: null, readback: null, readbackIssues: [], compatibilityPromoted: false };
  const fail = (detail: string): ControlledExecutionReport => ({ ...report, outcome: "ABORTED_PREFLIGHT", detail });

  // 0. the armed, unexpired, single-use authorization for EXACTLY this action
  const auth = await db.controlledTestAuthorization.findUnique({ where: { actionId }, include: { action: { select: { id: true, status: true, integrationId: true, rewardItemId: true, targetChargeDate: true } } } });
  if (!auth) return fail("No controlled-test authorization exists for this action. Arm it explicitly first.");
  if (auth.status !== "ARMED") return fail(`Authorization is ${auth.status} — it was single-use and cannot execute again.`);
  if (auth.expiresAt.getTime() < now.getTime()) {
    await db.controlledTestAuthorization.update({ where: { id: auth.id }, data: { status: "EXPIRED", armedKey: null, outcome: "EXPIRED", clearedAt: new Date() } });
    return fail("Authorization expired; arm again if the test is still wanted.");
  }
  const integration = await db.integration.findUniqueOrThrow({ where: { id: auth.integrationId }, select: { id: true, status: true, automationMode: true, displayName: true } });
  if (integration.status !== "CONNECTED") return fail("Integration is not connected.");

  // 1. FULL fresh preflight — the dry-run: internal invariants + live subscription GET + one-time scan
  const connector = opts.connector ?? (await getRechargeConnectorForIntegration(ctx, integration.id, { correlationId: `ctl_${actionId.slice(-8)}` })).connector;
  const pre = await dryRunAction(ctx, actionId, { now, persist: false, connector });
  report.preflight = { wouldExecute: pre.wouldExecute, blockingReason: pre.blockingReason, blockingDetail: pre.blockingDetail, operation: pre.operation, targetChargeDate: pre.targetChargeDate, external: pre.external, target: pre.target };
  if (!pre.wouldExecute || !pre.target || !pre.targetChargeDate) {
    return fail(`Preflight refused: ${pre.blockingReason ?? "no target"}${pre.blockingDetail ? ` (${pre.blockingDetail})` : ""}. Nothing was written.`);
  }
  const addressId = pre.external.externalAddressId;
  if (!addressId) return fail("Preflight could not confirm the live address id. Nothing was written.");

  // 2. consume the authorization + claim PLANNED → EXECUTING atomically (single use, single process)
  const claimed = await db.$transaction(async (tx) => {
    const a = await tx.controlledTestAuthorization.updateMany({ where: { id: auth.id, status: "ARMED" }, data: { status: "CONSUMED", armedKey: null, consumedAt: new Date() } });
    if (a.count !== 1) return false;
    const c = await tx.automationAction.updateMany({ where: { id: actionId, status: "PLANNED" }, data: { status: "EXECUTING", attemptCount: { increment: 1 } } });
    if (c.count !== 1) throw new ClaimLost();
    return true;
  }).catch((e) => {
    if (e instanceof ClaimLost) return false;
    throw e;
  });
  if (!claimed) return fail("Another process claimed the authorization or the action is no longer PLANNED. Nothing was written.");

  const finishAuth = async (outcome: string) => {
    await db.controlledTestAuthorization.update({ where: { id: auth.id }, data: { outcome, resultJson: report as unknown as Prisma.InputJsonValue } }).catch(() => undefined);
  };

  // adopt path — an identical one-time already exists (preflight found it): no POST at all
  if (pre.operation === "ADOPT_EXISTING_ONETIME" && pre.external.existingMarkerOnetime) {
    const adoptedId = pre.external.existingMarkerOnetime.externalOnetimeId;
    await attachAction(ctx, actionId, adoptedId, pre.targetChargeDate, "adopted pre-existing one-time (no write)");
    report.outcome = "ADOPTED";
    report.detail = `Adopted existing one-time ${adoptedId} — no POST was made.`;
    report.externalOnetimeId = adoptedId;
    report.readback = (await connector.getOnetime?.(adoptedId)) ?? null;
    await finishAuth("ADOPTED");
    return report;
  }

  // 3. exactly one POST /onetimes with the SAME body the dry-run previewed
  const rewardName = pre.target.rewardItem?.name ?? null;
  const body = buildOnetimeBody({ addressId, targetChargeDate: pre.targetChargeDate, target: { externalVariantId: pre.target.externalVariantId, externalProductId: pre.target.externalProductId, title: pre.target.title }, actionId, rewardName });
  report.requestBody = body as unknown as Record<string, unknown>;
  let created: ConnectorOnetime | null = null;
  let uncertain = false;
  let definiteFailure: string | null = null;
  try {
    created = await connector.createOnetime(body);
  } catch (e) {
    if (isRechargeError(e) && (e.kind === "VALIDATION_ERROR" || e.kind === "PERMISSION_ERROR" || e.kind === "AUTHENTICATION_ERROR" || e.kind === "NOT_FOUND")) {
      definiteFailure = `${e.kind}: ${e.message}`;
    } else {
      uncertain = true; // network death / 5xx / rate limit / malformed 2xx — the write MAY exist
      report.detail = `POST outcome uncertain (${e instanceof Error ? e.message : String(e)}); reconciling by read…`;
      logger.warn("controlled.uncertain_write", { actionId, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
  }

  if (definiteFailure) {
    await db.automationAction.update({ where: { id: actionId }, data: { status: "FAILED", lastError: definiteFailure.slice(0, 900), lastErrorAt: new Date() } });
    await logActivity(ctx, { actorType: ctx.userId ? "USER" : "SYSTEM", actorId: ctx.userId ?? null, eventType: "CONTROLLED_TEST_FAILED", entityType: "ACTION", entityId: actionId, summary: `Controlled test FAILED before creating anything: ${definiteFailure.slice(0, 200)}`, metadata: { definiteFailure: true } });
    report.outcome = "FAILED";
    report.detail = definiteFailure;
    await finishAuth("FAILED");
    return report;
  }

  // 4. uncertain outcome → READ reconciliation (adopt if found; ONE retry only after proven absence)
  if (uncertain) {
    const found = await findOurOnetime(connector, { addressId, actionId, variantId: pre.target.externalVariantId, targetChargeDate: pre.targetChargeDate });
    if (found) {
      created = found;
      report.detail += " reconciliation found the one-time — adopted, no retry.";
    } else {
      report.detail += " reconciliation positively found NO one-time — one controlled retry…";
      try {
        created = await connector.createOnetime(body);
        await db.automationAction.update({ where: { id: actionId }, data: { attemptCount: { increment: 1 } } });
      } catch (e2) {
        await db.automationAction.update({ where: { id: actionId }, data: { lastError: `UNCERTAIN_WRITE: ${(e2 instanceof Error ? e2.message : String(e2)).slice(0, 800)}`, lastErrorAt: new Date() } });
        report.outcome = "UNCERTAIN";
        report.detail += ` retry also inconclusive (${e2 instanceof Error ? e2.message.slice(0, 120) : String(e2)}). Action stays EXECUTING for operator reconciliation — NO further automatic retry.`;
        await logActivity(ctx, { actorType: "SYSTEM", eventType: "CONTROLLED_TEST_UNCERTAIN", entityType: "ACTION", entityId: actionId, summary: report.detail.slice(0, 400) });
        await finishAuth("UNCERTAIN");
        return report;
      }
    }
  }
  if (!created) {
    report.outcome = "UNCERTAIN";
    report.detail = report.detail || "No created one-time and no definite failure — action stays EXECUTING for operator reconciliation.";
    await finishAuth("UNCERTAIN");
    return report;
  }
  report.externalOnetimeId = created.externalOnetimeId;

  // 5. immediate authoritative read-back — ATTACHED only when EVERY field matches
  const readback = (await connector.getOnetime(created.externalOnetimeId)) ?? created;
  report.readback = readback;
  const issues: string[] = [];
  if (readback.externalOnetimeId !== created.externalOnetimeId) issues.push(`readback id ${readback.externalOnetimeId} != created ${created.externalOnetimeId}`);
  if (readback.externalAddressId !== addressId) issues.push(`address ${readback.externalAddressId} != ${addressId}`);
  if (readback.nextChargeDate !== pre.targetChargeDate) issues.push(`date ${readback.nextChargeDate} != ${pre.targetChargeDate}`);
  if (readback.externalVariantId !== pre.target.externalVariantId) issues.push(`variant ${readback.externalVariantId} != ${pre.target.externalVariantId}`);
  if (pre.target.externalProductId && readback.externalProductId !== pre.target.externalProductId) issues.push(`product ${readback.externalProductId} != ${pre.target.externalProductId}`);
  if (readback.quantity !== 1) issues.push(`quantity ${readback.quantity} != 1`);
  if (Number(readback.price) !== 0) issues.push(`price ${readback.price} != 0.00`);
  if (readback.properties && !readback.properties.some((p) => p.name === ACTION_PROPERTY && p.value === actionId)) issues.push("action property missing in provider response");
  report.readbackIssues = issues;

  if (issues.length > 0) {
    await db.automationAction.update({ where: { id: actionId }, data: { status: "FAILED", externalObjectType: "onetime", externalObjectId: created.externalOnetimeId, externalChargeDate: readback.nextChargeDate, lastError: `READBACK_MISMATCH: ${issues.join("; ").slice(0, 800)}`, lastErrorAt: new Date(), executedAt: new Date() } });
    await db.exception.create({ data: { organizationId: ctx.organizationId, integrationId: integration.id, actionId, severity: "CRITICAL", type: "CONTROLLED_TEST_READBACK_MISMATCH", title: "Controlled test read-back mismatch", description: `One-time ${created.externalOnetimeId} was created but the read-back does not match the approved payload: ${issues.join("; ")}. Use the controlled rollback to remove it if wrong.` } });
    await logActivity(ctx, { actorType: "SYSTEM", eventType: "CONTROLLED_TEST_READBACK_MISMATCH", entityType: "ACTION", entityId: actionId, summary: `Read-back mismatch for one-time ${created.externalOnetimeId}: ${issues.join("; ").slice(0, 300)}`, metadata: { externalOnetimeId: created.externalOnetimeId, issues } });
    report.outcome = "FAILED";
    report.detail = `One-time ${created.externalOnetimeId} exists but read-back mismatched: ${issues.join("; ")}`;
    await finishAuth("FAILED");
    return report;
  }

  await attachAction(ctx, actionId, created.externalOnetimeId, readback.nextChargeDate ?? pre.targetChargeDate, uncertain ? "attached after read reconciliation" : "attached after verified create + read-back");
  report.outcome = "ATTACHED";
  report.detail = `${report.detail ? `${report.detail} ` : ""}One-time ${created.externalOnetimeId} verified by authoritative read-back and ATTACHED.`;

  // 6. promote THIS variant's binding compatibility (never inferred for other variants)
  const promoted = await promoteBindingCompatibility(ctx, { actionRewardItemId: auth.action.rewardItemId, rechargeIntegrationId: integration.id, variantId: pre.target.externalVariantId, actionId, externalOnetimeId: created.externalOnetimeId });
  report.compatibilityPromoted = promoted;
  await finishAuth("ATTACHED");
  return report;
}

class ClaimLost extends Error {}

async function attachAction(ctx: Ctx, actionId: string, externalOnetimeId: string, chargeDate: string | null, how: string) {
  const db = dbFor(ctx);
  await db.automationAction.update({
    where: { id: actionId },
    data: { status: "ATTACHED", externalObjectType: "onetime", externalObjectId: externalOnetimeId, externalChargeDate: chargeDate, executedAt: new Date(), verifiedAt: new Date(), lastError: null, dryRun: false },
  });
  await logActivity(ctx, { actorType: ctx.userId ? "USER" : "SYSTEM", actorId: ctx.userId ?? null, eventType: "ACTION_ATTACHED", entityType: "ACTION", entityId: actionId, summary: `Controlled test: action ATTACHED — Recharge one-time ${externalOnetimeId} on charge ${chargeDate ?? "?"} (${how}).`, metadata: { externalOnetimeId, chargeDate, how } });
}

/** Search the address's one-times for OURS: the action property, else exact variant + date. */
export async function findOurOnetime(connector: Pick<RechargeConnector, "listOnetimes">, input: { addressId: string; actionId: string; variantId: string; targetChargeDate: string }): Promise<ConnectorOnetime | null> {
  let variantDateMatch: ConnectorOnetime | null = null;
  for await (const page of connector.listOnetimes({ externalAddressId: input.addressId })) {
    for (const o of page.items) {
      if (o.properties?.some((p) => p.name === ACTION_PROPERTY && p.value === input.actionId)) return o; // strongest identity
      if (o.externalVariantId === input.variantId && o.nextChargeDate === input.targetChargeDate) variantDateMatch = variantDateMatch ?? o;
    }
  }
  return variantDateMatch;
}

async function promoteBindingCompatibility(ctx: Ctx, input: { actionRewardItemId: string | null; rechargeIntegrationId: string; variantId: string; actionId: string; externalOnetimeId: string }): Promise<boolean> {
  if (!input.actionRewardItemId) return false;
  const db = dbFor(ctx);
  const binding = await db.rewardItemExternalBinding.findFirst({ where: { rewardItemId: input.actionRewardItemId, externalVariantId: input.variantId, integration: { pairedIntegrationId: input.rechargeIntegrationId } }, include: { rewardItem: { select: { name: true } } } });
  if (!binding) return false;
  const verification = ((binding.verificationJson as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
  await db.rewardItemExternalBinding.update({
    where: { id: binding.id },
    data: {
      rechargeCompatibility: "VERIFIED",
      verificationJson: { ...verification, rechargeVerification: { verifiedAt: new Date().toISOString(), rechargeIntegrationId: input.rechargeIntegrationId, shopifyVariantId: input.variantId, actionId: input.actionId, externalOnetimeId: input.externalOnetimeId } } as unknown as Prisma.InputJsonValue,
    },
  });
  await logActivity(ctx, { actorType: "SYSTEM", eventType: "REWARD_BINDING_RECHARGE_VERIFIED", entityType: "REWARD_ITEM", entityId: input.actionRewardItemId, summary: `"${binding.rewardItem.name}" (variant ${input.variantId}): rechargeCompatibility → VERIFIED — proven by controlled test action ${input.actionId}, Recharge one-time ${input.externalOnetimeId}. Other variants stay UNVERIFIED until tried.`, metadata: { bindingId: binding.id, externalOnetimeId: input.externalOnetimeId } });
  return true;
}

// ── rollback (explicit, narrowly scoped) ───────────────────────────────────

/**
 * Remove ONLY the controlled-test one-time this action created/attached. Requires: the action's
 * consumed authorization, a stored external id, and the live one-time to still carry our action
 * property (or match variant+date) before DELETE /onetimes/{id} is called.
 */
export async function rollbackControlledTest(ctx: Ctx, actionId: string, opts: { connector?: RechargeConnector; reason: string }): Promise<Result<{ deletedExternalOnetimeId: string }>> {
  const db = dbFor(ctx);
  const auth = await db.controlledTestAuthorization.findUnique({ where: { actionId }, select: { id: true, status: true, integrationId: true } });
  if (!auth || auth.status === "ARMED") return { ok: false, error: "No consumed controlled-test authorization for this action — nothing to roll back." };
  const action = await db.automationAction.findUnique({ where: { id: actionId }, select: { id: true, status: true, externalObjectId: true, externalObjectType: true, targetChargeDate: true, rewardItemId: true } });
  if (!action?.externalObjectId || action.externalObjectType !== "onetime") return { ok: false, error: "The action has no attached Recharge one-time recorded." };
  const connector = opts.connector ?? (await getRechargeConnectorForIntegration(ctx, auth.integrationId, { correlationId: `ctl_rb_${actionId.slice(-8)}` })).connector;
  const live = await connector.getOnetime(action.externalObjectId);
  if (!live) return { ok: false, error: `One-time ${action.externalObjectId} no longer exists in Recharge (it may already be consumed by a charge). Nothing deleted.` };
  const isOurs = live.properties?.some((p) => p.name === ACTION_PROPERTY && p.value === actionId) || (live.nextChargeDate === action.targetChargeDate && !!live.externalVariantId);
  if (!isOurs) return { ok: false, error: `One-time ${action.externalObjectId} does not carry this action's identity — refusing to delete.` };
  await connector.deleteOnetime(action.externalObjectId);
  const gone = await connector.getOnetime(action.externalObjectId);
  if (gone) return { ok: false, error: `DELETE returned but the one-time still exists — inspect manually.` };
  await db.$transaction(async (tx) => {
    await tx.automationAction.update({ where: { id: actionId }, data: { status: "CANCELLED", liveKey: null, ownerKey: null, cancelReason: `MANUAL: controlled test rolled back — ${opts.reason.slice(0, 200)}`, externalObjectId: action.externalObjectId, lastError: null } });
    await tx.controlledTestAuthorization.update({ where: { id: auth.id }, data: { outcome: "ROLLED_BACK", note: opts.reason.slice(0, 300) } });
    // demote the compatibility we promoted from THIS test, if it points at this one-time
    if (action.rewardItemId) {
      const binding = await tx.rewardItemExternalBinding.findFirst({ where: { rewardItemId: action.rewardItemId, integration: { pairedIntegrationId: auth.integrationId } } });
      const rv = (binding?.verificationJson as { rechargeVerification?: { externalOnetimeId?: string } } | null)?.rechargeVerification;
      if (binding && rv?.externalOnetimeId === action.externalObjectId) {
        const vj = { ...(binding.verificationJson as Record<string, unknown>) };
        delete vj.rechargeVerification;
        await tx.rewardItemExternalBinding.update({ where: { id: binding.id }, data: { rechargeCompatibility: "UNVERIFIED", verificationJson: vj as unknown as Prisma.InputJsonValue } });
      }
    }
  });
  await logActivity(ctx, { actorType: ctx.userId ? "USER" : "SYSTEM", actorId: ctx.userId ?? null, eventType: "CONTROLLED_TEST_ROLLED_BACK", entityType: "ACTION", entityId: actionId, summary: `Controlled-test one-time ${action.externalObjectId} deleted from Recharge (${opts.reason.slice(0, 150)}); action CANCELLED; compatibility demoted if promoted by this test.`, metadata: { externalOnetimeId: action.externalObjectId, reason: opts.reason } });
  return { ok: true, data: { deletedExternalOnetimeId: action.externalObjectId } };
}

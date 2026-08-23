/**
 * DRY_RUN executor (Phase 4). Loads FRESH internal state and READ-ONLY external state for one
 * PLANNED action and produces a structured preview: would we execute, why not, and the exact
 * provider operation we WOULD send. Nothing is ever sent: the connector exposes no write method
 * and this module never constructs an HTTP request.
 *
 * The preview is stored on the action (dryRunJson / wouldExecute / blockingReason / lastDryRunAt)
 * so Upcoming can show it, and an activity row records each run.
 */
import type { AutomationMode } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import { logActivity } from "@/lib/domain/activity/log";
import { getRechargeConnectorForIntegration, IntegrationUnavailableError } from "@/lib/domain/integrations/connector";
import { evaluateJourneyEligibility, type IneligibilityReason } from "@/lib/domain/eligibility/evaluate";
import { qualifyForRule, type DisqualificationReason } from "@/lib/domain/eligibility/qualify";
import { loadProgramPopulation } from "@/lib/domain/eligibility/population";
import type { ConnectorOnetime, ConnectorSubscription } from "@/lib/integrations/types";
import { isRechargeError } from "@/lib/integrations/recharge/errors";
import { logger } from "@/lib/logging/logger";

type Ctx = { organizationId: string };

export type DryRunBlockingReason =
  | "ACTION_NOT_PLANNED"
  | "INTEGRATION_NOT_CONNECTED"
  | "AUTOMATION_OFF"
  | "RULE_NOT_READY"
  | "MARKER_UNAVAILABLE"
  | "MARKER_PLACEHOLDER"
  | IneligibilityReason
  | DisqualificationReason
  | "JOURNEY_NOT_AT_PREVIOUS_DELIVERY"
  | "TARGET_CHARGE_MOVED"
  | "EXTERNAL_SUBSCRIPTION_NOT_ACTIVE"
  | "EXTERNAL_NO_UPCOMING_CHARGE"
  | "EXTERNAL_READ_FAILED";

export type DryRunResult = {
  actionId: string;
  ranAt: string;
  mode: AutomationMode;
  wouldExecute: boolean;
  timing: "DUE" | "SCHEDULED";
  blockingReason: DryRunBlockingReason | null;
  blockingDetail: string | null;
  operation: "CREATE_ONETIME" | "ADOPT_EXISTING_ONETIME";
  customer: { name: string; email: string | null; externalCustomerId: string };
  subscription: { id: string; externalSubscriptionId: string; status: string; productTitle: string | null; nextChargeDate: string | null; externalAddressId: string };
  programme: { id: string; name: string };
  journey: { id: string; successfulCycles: number; cycles: { cycleNumber: number; externalOrderId: string; processedAt: string }[]; lifetimeDeliveries: number };
  rule: { id: string; name: string; status: string; eligibilityScope: string | null; cycleNumber: number };
  targetCycle: number;
  targetChargeDate: string | null;
  targetChargeAt: string | null;
  executeAfter: string | null;
  marker: { id: string; name: string; title: string | null; sku: string | null; externalVariantId: string; externalProductId: string | null; placeholder: boolean; active: boolean };
  external: {
    read: boolean;
    subscriptionStatus: string | null;
    nextChargeDate: string | null;
    externalAddressId: string | null;
    externalProductId: string | null;
    externalVariantId: string | null;
    existingMarkerOnetime: { externalOnetimeId: string; nextChargeDate: string | null } | null;
    error: string | null;
  };
  /** the exact provider operation we WOULD perform — never sent in DRY_RUN */
  intendedOperation: {
    provider: "RECHARGE";
    apiVersion: "2021-11";
    method: "POST";
    path: "/onetimes";
    body: Record<string, unknown>;
    sent: false;
    note: string;
  };
};

export async function dryRunAction(ctx: Ctx, actionId: string, opts: { now?: Date; persist?: boolean; connector?: { getSubscription: (id: string) => Promise<ConnectorSubscription>; listOnetimes: (o: { externalAddressId?: string }) => AsyncIterable<{ items: ConnectorOnetime[] }> } } = {}): Promise<DryRunResult> {
  const db = dbFor(ctx);
  const now = opts.now ?? new Date();
  const persist = opts.persist !== false;

  const a = await db.automationAction.findUnique({
    where: { id: actionId },
    include: {
      subscription: { include: { customer: { select: { firstName: true, lastName: true, email: true } } } },
      journey: { include: { program: { select: { id: true, name: true } }, cycles: { orderBy: { cycleNumber: "asc" }, select: { cycleNumber: true, externalOrderId: true, processedAt: true } } } },
      rule: true,
      fulfillmentMarker: true,
      integration: { select: { id: true, status: true, automationMode: true, displayName: true } },
    },
  });
  if (!a) throw new Error("Action not found in this organisation.");

  const customerName = [a.subscription.customer?.firstName, a.subscription.customer?.lastName].filter(Boolean).join(" ") || a.subscription.customer?.email || "Unknown customer";
  const blockers: { reason: DryRunBlockingReason; detail?: string }[] = [];
  const block = (reason: DryRunBlockingReason, detail?: string) => blockers.push({ reason, detail });

  // ── fresh internal state ──
  if (a.status !== "PLANNED") block("ACTION_NOT_PLANNED", a.status);
  if (a.integration.status !== "CONNECTED") block("INTEGRATION_NOT_CONNECTED");
  if (a.integration.automationMode === "OFF") block("AUTOMATION_OFF");
  if (!a.rule || (a.rule.status !== "READY" && a.rule.status !== "ACTIVE")) block("RULE_NOT_READY", a.rule?.status);
  if (!a.fulfillmentMarker.active) block("MARKER_UNAVAILABLE", "inactive");
  if (a.fulfillmentMarker.placeholder) block("MARKER_PLACEHOLDER");

  // scope-aware re-qualification from the shared population (lifetime evidence)
  let lifetime = a.journey.successfulCycles;
  const population = await loadProgramPopulation(ctx, a.journey.programId, { integrationId: a.integrationId });
  const row = population.rows.find((r) => r.subscriptionId === a.subscriptionId);
  if (row) {
    lifetime = row.lifetimeDeliveries;
    const elig = evaluateJourneyEligibility({
      subscription: { status: row.status, mappingStatus: row.mappingStatus, nextChargeDate: row.nextChargeDate, latestJourneyId: row.latestJourneyId, automationOverride: row.automationOverride },
      journey: row.latestJourney ? { id: row.latestJourney.id, endedAt: row.latestJourney.endedAt, programId: row.latestJourney.programId } : null,
      resolvedProgramId: row.resolvedProgramId,
      integration: row.integration,
    });
    if (!elig.eligible) for (const r of elig.reasons) block(r);
    if (row.latestJourneyId !== a.journeyId) block("NOT_LATEST_JOURNEY");
    if (a.rule) {
      const qual = qualifyForRule({
        rule: { status: a.rule.status, programId: a.rule.programId, cycleNumber: a.rule.cycleNumber, eligibilityScope: a.rule.eligibilityScope },
        journey: { programId: a.journey.programId, successfulCycles: a.journey.successfulCycles },
        customerLifetimeDeliveries: row.lifetimeDeliveries,
        allowReady: true,
      });
      if (!qual.qualifies && qual.reason !== "ACTION_EXISTS") block(qual.reason);
    }
  } else {
    block("NO_JOURNEY", "subscription no longer in the programme population");
  }
  if (a.journey.successfulCycles !== a.targetCycle - 1) block("JOURNEY_NOT_AT_PREVIOUS_DELIVERY", `journey at ${a.journey.successfulCycles}, target ${a.targetCycle}`);

  // ── read-only external state ──
  const external: DryRunResult["external"] = { read: false, subscriptionStatus: null, nextChargeDate: null, externalAddressId: null, externalProductId: null, externalVariantId: null, existingMarkerOnetime: null, error: null };
  try {
    const connector = opts.connector ?? (await getRechargeConnectorForIntegration(ctx, a.integrationId, { correlationId: `dryrun:${a.id}` })).connector;
    const ext = await connector.getSubscription(a.subscription.externalSubscriptionId);
    external.read = true;
    external.subscriptionStatus = ext.providerStatus;
    external.nextChargeDate = ext.nextChargeDate;
    external.externalAddressId = ext.externalAddressId;
    external.externalProductId = ext.externalProductId;
    external.externalVariantId = ext.externalVariantId;
    if (ext.status !== "active") block("EXTERNAL_SUBSCRIPTION_NOT_ACTIVE", ext.providerStatus);
    if (!ext.nextChargeDate) block("EXTERNAL_NO_UPCOMING_CHARGE");
    else if (a.targetChargeDate && ext.nextChargeDate !== a.targetChargeDate) block("TARGET_CHARGE_MOVED", `planned ${a.targetChargeDate}, provider now ${ext.nextChargeDate} — planner will replan after the next sync`);
    // existing one-time with the marker variant on this address (would be ADOPTED, not duplicated)
    for await (const page of connector.listOnetimes({ externalAddressId: ext.externalAddressId })) {
      const hit = page.items.find((o) => o.externalVariantId === a.fulfillmentMarker.externalVariantId && (!a.targetChargeDate || o.nextChargeDate === a.targetChargeDate));
      if (hit) {
        external.existingMarkerOnetime = { externalOnetimeId: hit.externalOnetimeId, nextChargeDate: hit.nextChargeDate };
        break;
      }
    }
  } catch (e) {
    external.error = e instanceof IntegrationUnavailableError || isRechargeError(e) ? String((e as Error).message).slice(0, 300) : String(e).slice(0, 300);
    block("EXTERNAL_READ_FAILED", external.error);
  }

  const first = blockers[0] ?? null;
  const body: Record<string, unknown> = {
    address_id: /^d+$/.test(external.externalAddressId ?? a.subscription.externalAddressId) ? Number(external.externalAddressId ?? a.subscription.externalAddressId) : (external.externalAddressId ?? a.subscription.externalAddressId),
    next_charge_scheduled_at: a.targetChargeDate,
    external_variant_id: { ecommerce: a.fulfillmentMarker.externalVariantId },
    ...(a.fulfillmentMarker.externalProductId ? { external_product_id: { ecommerce: a.fulfillmentMarker.externalProductId } } : {}),
    product_title: a.fulfillmentMarker.title ?? a.fulfillmentMarker.name,
    quantity: 1,
    price: "0.00",
    properties: [{ name: "_subscription_ops_action", value: a.id }],
  };
  const result: DryRunResult = {
    actionId: a.id,
    ranAt: now.toISOString(),
    mode: a.integration.automationMode,
    wouldExecute: blockers.length === 0,
    timing: a.executeAfter && a.executeAfter.getTime() <= now.getTime() ? "DUE" : "SCHEDULED",
    blockingReason: first?.reason ?? null,
    blockingDetail: first?.detail ?? null,
    operation: external.existingMarkerOnetime ? "ADOPT_EXISTING_ONETIME" : "CREATE_ONETIME",
    customer: { name: customerName, email: a.subscription.customer?.email ?? null, externalCustomerId: a.subscription.externalCustomerId },
    subscription: { id: a.subscription.id, externalSubscriptionId: a.subscription.externalSubscriptionId, status: a.subscription.status, productTitle: a.subscription.productTitleSnapshot, nextChargeDate: a.subscription.nextChargeDate, externalAddressId: a.subscription.externalAddressId },
    programme: { id: a.journey.program.id, name: a.journey.program.name },
    journey: { id: a.journey.id, successfulCycles: a.journey.successfulCycles, cycles: a.journey.cycles.map((c) => ({ cycleNumber: c.cycleNumber, externalOrderId: c.externalOrderId, processedAt: c.processedAt.toISOString() })), lifetimeDeliveries: lifetime },
    rule: { id: a.rule?.id ?? "", name: a.rule?.name ?? "(rule removed)", status: a.rule?.status ?? "—", eligibilityScope: a.rule?.eligibilityScope ?? a.eligibilityScope ?? null, cycleNumber: a.rule?.cycleNumber ?? a.targetCycle },
    targetCycle: a.targetCycle,
    targetChargeDate: a.targetChargeDate,
    targetChargeAt: a.targetChargeAt?.toISOString() ?? null,
    executeAfter: a.executeAfter?.toISOString() ?? null,
    marker: { id: a.fulfillmentMarker.id, name: a.fulfillmentMarker.name, title: a.fulfillmentMarker.title, sku: a.fulfillmentMarker.sku, externalVariantId: a.fulfillmentMarker.externalVariantId, externalProductId: a.fulfillmentMarker.externalProductId, placeholder: a.fulfillmentMarker.placeholder, active: a.fulfillmentMarker.active },
    external,
    intendedOperation: {
      provider: "RECHARGE",
      apiVersion: "2021-11",
      method: "POST",
      path: "/onetimes",
      body,
      sent: false,
      note: external.existingMarkerOnetime
        ? `A one-time with this variant already exists on the address for ${external.existingMarkerOnetime.nextChargeDate} (id ${external.existingMarkerOnetime.externalOnetimeId}); the live executor would ADOPT it instead of creating a second one.`
        : "Dry run: this is the payload the live executor would POST. Not sent. Field shapes to be verified against the 2021-11 one-time create contract before the live phase.",
    },
  };

  if (persist && a.status === "PLANNED") {
    await db.automationAction.update({ where: { id: a.id }, data: { lastDryRunAt: now, dryRunJson: result as unknown as Prisma.InputJsonValue, wouldExecute: result.wouldExecute, blockingReason: result.blockingReason ? `${result.blockingReason}${result.blockingDetail ? `: ${result.blockingDetail}` : ""}` : null } });
    await logActivity(ctx, {
      actorType: "SYSTEM",
      eventType: "ACTION_DRY_RUN",
      entityType: "ACTION",
      entityId: a.id,
      summary: `Dry run for ${customerName} · ${a.journey.program.name} delivery ${a.targetCycle}: ${result.wouldExecute ? `would ${result.operation === "ADOPT_EXISTING_ONETIME" ? "adopt existing one-time" : "create one-time"} on ${a.targetChargeDate}` : `would NOT execute — ${result.blockingReason}`}${external.read ? "" : " (external read failed)"}`,
      metadata: { wouldExecute: result.wouldExecute, blockingReason: result.blockingReason, timing: result.timing, externalRead: external.read },
    });
  }
  logger.info("dryrun.completed", { actionId: a.id, wouldExecute: result.wouldExecute, blockingReason: result.blockingReason, externalRead: external.read });
  return result;
}

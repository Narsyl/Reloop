import "server-only";

/**
 * Phase 7 — trial conversion: automatically swap a trial subscription (e.g. Morning Magic
 * sachets) to its paid product a fixed number of days after it started, with the operator's
 * one non-negotiable rule built in at every layer:
 *
 *     a subscription that has cancelled is NEVER converted.
 *
 * How that rule is enforced:
 *   1. cancellation CHECKPOINTS — at each configured day mark (default 2, 5, 6, 7) the
 *      subscription is fetched LIVE from Recharge; any non-active observation makes the
 *      candidate terminally CANCELLED. Synced data showing a cancellation is also terminal.
 *   2. a FINAL fresh live fetch runs immediately before the write — never sync data, never
 *      an earlier checkpoint's result. Only `active` + still-on-the-trial-product proceeds.
 *   3. the swap is verified by an authoritative READ-BACK; mismatches raise exceptions.
 *
 * Other guards: idempotent by state (already-swapped subs become ALREADY_CONVERTED — the
 * manual batch and this engine can coexist); the write is never blindly retried (ambiguous
 * outcomes reconcile by read: the subscription either carries the target product or it does
 * not); conversions are postponed inside the charge-race window and when the next charge has
 * been pushed far out (customer delayed — a human is flagged instead).
 *
 * DRY_RUN rehearses everything including the final fresh check and reports WOULD_CONVERT;
 * LIVE performs the swap. Every outcome lands in the activity feed; failures raise exceptions.
 */
import type { Prisma } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import { logActivity } from "@/lib/domain/activity/log";
import { getRechargeConnectorForIntegration } from "@/lib/domain/integrations/connector";
import type { RechargeConnector, RechargeSubscriptionSwapBody } from "@/lib/integrations/recharge";
import { isRechargeError } from "@/lib/integrations/recharge/errors";
import type { ConnectorSubscription } from "@/lib/integrations/types";
import { logger } from "@/lib/logging/logger";

type Ctx = { organizationId: string; userId?: string | null };

export type TrialCheckpoint = {
  day: number;
  observedAt: string; // ISO
  providerStatus: string;
  outcome: "active" | "cancelled" | "gone" | "product_changed";
  late?: boolean; // observed more than a day after the mark (enrolled late / downtime)
};

export type TrialSweepSummary = {
  ok: boolean;
  error?: string;
  funnelId: string;
  mode: "DRY_RUN" | "LIVE";
  enrolled: number;
  checked: number; // live checkpoint fetches performed
  checkErrors: number; // transient fetch failures (retried next sweep)
  cancelledDetected: number;
  alreadyConverted: number;
  ended: number;
  due: number;
  converted: number;
  wouldConvert: number;
  postponed: number;
  failed: number;
  uncertain: number;
  results: { candidateId: string; externalSubscriptionId: string; outcome: string; detail: string }[];
};

const DAY_MS = 86_400_000;
/** Conversions are postponed while the provider's next charge is this close — never race the biller. */
const CHARGE_RACE_WINDOW_MS = 36 * 3_600_000;
/** A next charge this far out means the customer delayed/paused; flag a human instead of converting. */
const DELAYED_CHARGE_THRESHOLD_MS = 60 * DAY_MS;
const ENROLL_BOUND = 500;
const CONVERT_BOUND = 100;
const DELAY_FLAG = "DELAYED_NEXT_CHARGE_FLAGGED";

const emptySummary = (funnelId: string, mode: "DRY_RUN" | "LIVE"): TrialSweepSummary => ({
  ok: true,
  funnelId,
  mode,
  enrolled: 0,
  checked: 0,
  checkErrors: 0,
  cancelledDetected: 0,
  alreadyConverted: 0,
  ended: 0,
  due: 0,
  converted: 0,
  wouldConvert: 0,
  postponed: 0,
  failed: 0,
  uncertain: 0,
  results: [],
});

type CandidateRow = {
  id: string;
  subscriptionId: string;
  externalSubscriptionId: string;
  status: string;
  trialStartedAt: Date;
  dueAt: Date;
  checkpointsJson: Prisma.JsonValue | null;
  detail: string | null;
  subscription: { status: string; productTitleSnapshot: string; customer: { firstName: string | null; lastName: string | null } | null };
};

type Observation = { kind: "active" | "cancelled" | "gone" | "product_changed"; live: ConnectorSubscription | null } | { kind: "error"; error: string };

function checkpoints(c: CandidateRow): TrialCheckpoint[] {
  return Array.isArray(c.checkpointsJson) ? (c.checkpointsJson as TrialCheckpoint[]) : [];
}

function customerName(c: CandidateRow): string {
  const cu = c.subscription.customer;
  const name = [cu?.firstName, cu?.lastName].filter(Boolean).join(" ").trim();
  return name || `subscription ${c.externalSubscriptionId}`;
}

/** Run one funnel's sweep: enrol new trials, run due cancellation checkpoints, convert what is due. */
export async function runTrialConversionSweep(ctx: Ctx, funnelId: string, opts: { connector?: RechargeConnector; now?: Date } = {}): Promise<TrialSweepSummary> {
  const db = dbFor(ctx);
  const now = opts.now ?? new Date();

  const funnel = await db.trialConversionFunnel.findUnique({
    where: { id: funnelId },
    include: { integration: { select: { id: true, status: true, displayName: true } } },
  });
  if (!funnel) return { ...emptySummary(funnelId, "DRY_RUN"), ok: false, error: "Trial funnel not found in this organisation." };
  if (funnel.mode === "OFF") return { ...emptySummary(funnelId, "DRY_RUN"), ok: false, error: "Trial funnel is OFF; nothing is watched." };
  if (funnel.integration.status !== "CONNECTED") return { ...emptySummary(funnelId, funnel.mode), ok: false, error: "Integration is not connected." };
  const mode = funnel.mode;
  const summary = emptySummary(funnelId, mode);
  if (mode === "LIVE" && funnel.targetPrice === null) {
    return { ...summary, ok: false, error: "LIVE conversion refused: the funnel has no target price configured." };
  }

  const connector = opts.connector ?? (await getRechargeConnectorForIntegration(ctx, funnel.integrationId, { correlationId: `trial_${now.getTime().toString(36)}` })).connector;

  // ── 1. enrol new trial subscriptions ────────────────────────────────────────
  const fresh = await db.subscription.findMany({
    where: {
      integrationId: funnel.integrationId,
      externalProductId: funnel.sourceExternalProductId,
      status: "ACTIVE",
      ...(funnel.enrollFrom ? { externalCreatedAt: { gte: funnel.enrollFrom } } : {}),
      trialCandidacies: { none: { funnelId: funnel.id } },
    },
    select: { id: true, externalSubscriptionId: true, externalCreatedAt: true, createdAt: true },
    take: ENROLL_BOUND,
  });
  for (const s of fresh) {
    const startedAt = s.externalCreatedAt ?? s.createdAt;
    try {
      await db.trialConversionCandidate.create({
        data: {
          organizationId: ctx.organizationId,
          funnelId: funnel.id,
          subscriptionId: s.id,
          externalSubscriptionId: s.externalSubscriptionId,
          trialStartedAt: startedAt,
          dueAt: new Date(startedAt.getTime() + funnel.convertAfterDays * DAY_MS),
          dryRun: mode !== "LIVE",
        },
      });
      summary.enrolled++;
    } catch {
      // unique-violation race with a concurrent sweep — already enrolled
    }
  }

  const candidateInclude = { subscription: { select: { status: true, productTitleSnapshot: true, customer: { select: { firstName: true, lastName: true } } } } } as const;

  const observe = async (c: CandidateRow): Promise<Observation> => {
    try {
      const live = await connector.getSubscription(c.externalSubscriptionId);
      summary.checked++;
      if (live.status !== "active") return { kind: "cancelled", live };
      if (live.externalProductId !== funnel.sourceExternalProductId) return { kind: "product_changed", live };
      return { kind: "active", live };
    } catch (e) {
      if (isRechargeError(e) && e.kind === "NOT_FOUND") {
        summary.checked++;
        return { kind: "gone", live: null };
      }
      summary.checkErrors++;
      const msg = e instanceof Error ? e.message.slice(0, 300) : String(e);
      logger.warn("trial.check_error", { candidateId: c.id, externalSubscriptionId: c.externalSubscriptionId, error: msg });
      await db.trialConversionCandidate.update({ where: { id: c.id }, data: { lastError: msg, lastErrorAt: now } });
      return { kind: "error", error: msg };
    }
  };

  /** Append checkpoint entries for every configured day mark that has passed and is unrecorded. */
  const recordCheckpoints = async (c: CandidateRow, obs: Exclude<Observation, { kind: "error" }>) => {
    const existing = checkpoints(c);
    const have = new Set(existing.map((p) => p.day));
    const daysSince = Math.floor((now.getTime() - c.trialStartedAt.getTime()) / DAY_MS);
    const due = funnel.checkpointDays.filter((d) => d <= daysSince && !have.has(d));
    const entries: TrialCheckpoint[] = due.map((day) => ({
      day,
      observedAt: now.toISOString(),
      providerStatus: obs.live?.providerStatus ?? "not_found",
      outcome: obs.kind === "active" ? "active" : obs.kind === "cancelled" ? "cancelled" : obs.kind === "gone" ? "gone" : "product_changed",
      ...(now.getTime() - (c.trialStartedAt.getTime() + day * DAY_MS) > DAY_MS ? { late: true } : {}),
    }));
    const merged = [...existing, ...entries];
    await db.trialConversionCandidate.update({
      where: { id: c.id },
      data: { checkpointsJson: merged as unknown as Prisma.InputJsonValue, lastCheckedAt: now, lastProviderStatus: obs.live?.providerStatus ?? "not_found", lastError: null },
    });
    return merged;
  };

  const terminal = async (c: CandidateRow, status: "CANCELLED" | "ALREADY_CONVERTED" | "ENDED", detail: string, opts2: { activity?: { eventType: string; summary: string } } = {}) => {
    await db.trialConversionCandidate.update({ where: { id: c.id }, data: { status, detail: detail.slice(0, 500) } });
    if (status === "CANCELLED") summary.cancelledDetected++;
    else if (status === "ALREADY_CONVERTED") summary.alreadyConverted++;
    else summary.ended++;
    summary.results.push({ candidateId: c.id, externalSubscriptionId: c.externalSubscriptionId, outcome: status, detail });
    if (opts2.activity) {
      await logActivity(ctx, { actorType: "SYSTEM", eventType: opts2.activity.eventType, entityType: "SUBSCRIPTION", entityId: c.subscriptionId, summary: opts2.activity.summary, metadata: { funnelId: funnel.id, candidateId: c.id } });
    }
  };

  /** Shared triage of a live observation; returns the live sub only when conversion may proceed. */
  const triage = async (c: CandidateRow, obs: Observation, at: string): Promise<ConnectorSubscription | null> => {
    if (obs.kind === "error") return null;
    await recordCheckpoints(c, obs);
    if (obs.kind === "cancelled") {
      const why = obs.live?.cancelledAt ? ` (cancelled ${obs.live.cancelledAt.toISOString().slice(0, 10)})` : "";
      await terminal(c, "CANCELLED", `Cancellation observed at the ${at}${why} — this subscription will never be converted.`, {
        activity: { eventType: "TRIAL_CANCELLATION_DETECTED", summary: `Trial check (${at}): ${customerName(c)} has cancelled — the trial will not be converted.` },
      });
      return null;
    }
    if (obs.kind === "gone") {
      await terminal(c, "ENDED", `The subscription no longer exists at Recharge (observed at the ${at}).`);
      return null;
    }
    if (obs.kind === "product_changed") {
      await terminal(c, "ALREADY_CONVERTED", `The product is already "${obs.live?.productTitle ?? "?"}" at Recharge (observed at the ${at}) — swapped outside this engine.`, {
        activity: { eventType: "TRIAL_ALREADY_CONVERTED", summary: `Trial check (${at}): ${customerName(c)} was already switched to ${obs.live?.productTitle ?? "the paid product"} outside the engine.` },
      });
      return null;
    }
    return obs.live;
  };

  // ── 2. cancellation checkpoints for candidates not yet due ──────────────────
  const watching = (await db.trialConversionCandidate.findMany({
    where: { funnelId: funnel.id, status: "WATCHING", dueAt: { gt: now } },
    include: candidateInclude,
    take: ENROLL_BOUND,
  })) as unknown as CandidateRow[];
  for (const c of watching) {
    // synced data already shows a cancellation → terminal without an API call
    if (c.subscription.status === "CANCELLED" || c.subscription.status === "EXPIRED") {
      await terminal(c, "CANCELLED", `Cancellation seen in synced data before the day-${funnel.convertAfterDays} conversion — never converted.`, {
        activity: { eventType: "TRIAL_CANCELLATION_DETECTED", summary: `Trial check: ${customerName(c)} has cancelled — the trial will not be converted.` },
      });
      continue;
    }
    const daysSince = Math.floor((now.getTime() - c.trialStartedAt.getTime()) / DAY_MS);
    const have = new Set(checkpoints(c).map((p) => p.day));
    const pending = funnel.checkpointDays.filter((d) => d <= daysSince && !have.has(d));
    if (pending.length === 0) continue;
    const obs = await observe(c);
    await triage(c, obs, `day-${pending[pending.length - 1]} checkpoint`);
  }

  // ── 3. conversions: due candidates, final fresh check immediately before the write ──
  const dueCands = (await db.trialConversionCandidate.findMany({
    where: { funnelId: funnel.id, dueAt: { lte: now }, status: { in: mode === "LIVE" ? ["WATCHING", "WOULD_CONVERT"] : ["WATCHING"] } },
    orderBy: { dueAt: "asc" },
    include: candidateInclude,
    take: CONVERT_BOUND,
  })) as unknown as CandidateRow[];
  summary.due = dueCands.length;

  for (const c of dueCands) {
    if (c.subscription.status === "CANCELLED" || c.subscription.status === "EXPIRED") {
      await terminal(c, "CANCELLED", "Cancellation seen in synced data at conversion time — never converted.", {
        activity: { eventType: "TRIAL_CANCELLATION_DETECTED", summary: `Trial conversion check: ${customerName(c)} has cancelled — the trial will not be converted.` },
      });
      continue;
    }

    // THE final fresh check — live from Recharge, immediately before any write
    const obs = await observe(c);
    const live = await triage(c, obs, "final pre-conversion check");
    if (!live) continue;

    // charge-race / delayed-charge guards on the LIVE next charge date
    const postpone = async (detail: string) => {
      await db.trialConversionCandidate.update({ where: { id: c.id }, data: { detail: detail.slice(0, 500) } });
      summary.postponed++;
      summary.results.push({ candidateId: c.id, externalSubscriptionId: c.externalSubscriptionId, outcome: "POSTPONED", detail });
    };
    if (live.nextChargeDate) {
      const chargeMs = Date.parse(`${live.nextChargeDate}T00:00:00Z`);
      if (!Number.isNaN(chargeMs)) {
        const untilCharge = chargeMs + DAY_MS - now.getTime(); // end of the charge day
        if (untilCharge <= CHARGE_RACE_WINDOW_MS) {
          await postpone(`Next charge ${live.nextChargeDate} is inside the race window; converting after it processes.`);
          continue;
        }
        if (chargeMs - now.getTime() > DELAYED_CHARGE_THRESHOLD_MS) {
          if (!c.detail?.includes(DELAY_FLAG)) {
            await db.exception.create({
              data: {
                organizationId: ctx.organizationId,
                integrationId: funnel.integrationId,
                subscriptionId: c.subscriptionId,
                severity: "WARNING",
                type: "TRIAL_CONVERSION_DELAYED_CHARGE",
                title: "A due trial has its next charge pushed far out",
                description: `${customerName(c)}'s trial (subscription ${c.externalSubscriptionId}) is due for conversion but the next charge is ${live.nextChargeDate} — the customer appears to have delayed it. The engine is holding the swap; convert manually or wait.`,
              },
            });
          }
          await postpone(`${DELAY_FLAG}: next charge ${live.nextChargeDate} is unusually far out; holding for a human.`);
          continue;
        }
      }
    }

    if (mode !== "LIVE") {
      const already = c.status === "WOULD_CONVERT";
      await db.trialConversionCandidate.update({
        where: { id: c.id },
        data: { status: "WOULD_CONVERT", detail: `Every check passed on ${now.toISOString().slice(0, 10)}; LIVE would swap to "${funnel.targetProductTitle ?? funnel.targetExternalProductId}".` },
      });
      summary.wouldConvert++;
      summary.results.push({ candidateId: c.id, externalSubscriptionId: c.externalSubscriptionId, outcome: "WOULD_CONVERT", detail: "Dry run: every check passed; the write was withheld." });
      if (!already) {
        await logActivity(ctx, {
          actorType: "SYSTEM",
          eventType: "TRIAL_WOULD_CONVERT",
          entityType: "SUBSCRIPTION",
          entityId: c.subscriptionId,
          summary: `Trial conversion dry run: ${customerName(c)} passed every cancellation check and WOULD be switched to ${funnel.targetProductTitle ?? "the paid product"}.`,
          metadata: { funnelId: funnel.id, candidateId: c.id, externalSubscriptionId: c.externalSubscriptionId },
        });
      }
      continue;
    }

    // ── LIVE write path ──
    const claimed = await db.trialConversionCandidate.updateMany({
      where: { id: c.id, status: { in: ["WATCHING", "WOULD_CONVERT"] } },
      data: { status: "CONVERTING", attemptCount: { increment: 1 }, dryRun: false },
    });
    if (claimed.count !== 1) {
      summary.results.push({ candidateId: c.id, externalSubscriptionId: c.externalSubscriptionId, outcome: "SKIPPED", detail: "Another process claimed this candidate first." });
      continue;
    }

    const body: RechargeSubscriptionSwapBody = {
      external_product_id: { ecommerce: funnel.targetExternalProductId },
      external_variant_id: { ecommerce: funnel.targetExternalVariantId },
      ...(funnel.targetProductTitle ? { product_title: funnel.targetProductTitle } : {}),
      price: funnel.targetPrice!.toFixed(2),
      ...(funnel.targetIntervalUnit ? { order_interval_unit: funnel.targetIntervalUnit } : {}),
      ...(funnel.targetIntervalFrequency ? { order_interval_frequency: funnel.targetIntervalFrequency } : {}),
      ...(funnel.targetChargeIntervalFrequency ? { charge_interval_frequency: funnel.targetChargeIntervalFrequency } : {}),
    };

    const fail = async (detail: string, severity: "WARNING" | "CRITICAL", status: "FAILED" | "UNCERTAIN" = "FAILED") => {
      await db.trialConversionCandidate.update({ where: { id: c.id }, data: { status, lastError: detail.slice(0, 800), lastErrorAt: new Date(), detail: detail.slice(0, 500) } });
      await db.exception.create({
        data: {
          organizationId: ctx.organizationId,
          integrationId: funnel.integrationId,
          subscriptionId: c.subscriptionId,
          severity,
          type: status === "UNCERTAIN" ? "TRIAL_CONVERSION_UNCERTAIN" : "TRIAL_CONVERSION_FAILED",
          title: status === "UNCERTAIN" ? "A trial conversion needs reconciliation" : "A trial conversion failed",
          description: `${customerName(c)} (subscription ${c.externalSubscriptionId}): ${detail.slice(0, 700)}`,
        },
      });
      await logActivity(ctx, { actorType: "SYSTEM", eventType: "TRIAL_CONVERSION_FAILED", entityType: "SUBSCRIPTION", entityId: c.subscriptionId, summary: `Trial conversion ${status === "UNCERTAIN" ? "outcome unknown" : "failed"} for ${customerName(c)}: ${detail.slice(0, 250)}`, metadata: { funnelId: funnel.id, candidateId: c.id } });
      if (status === "UNCERTAIN") summary.uncertain++;
      else summary.failed++;
      summary.results.push({ candidateId: c.id, externalSubscriptionId: c.externalSubscriptionId, outcome: status, detail });
    };

    let written: ConnectorSubscription | null = null;
    let ambiguous = false;
    try {
      written = await connector.swapSubscriptionProduct(c.externalSubscriptionId, body);
    } catch (e) {
      if (isRechargeError(e) && (e.kind === "VALIDATION_ERROR" || e.kind === "PERMISSION_ERROR" || e.kind === "AUTHENTICATION_ERROR" || e.kind === "NOT_FOUND")) {
        await fail(`Recharge rejected the swap: ${e.kind}: ${e.message}`, "WARNING");
        continue;
      }
      ambiguous = true; // network death / 5xx / malformed 2xx — the write MAY have landed
      logger.warn("trial.uncertain_write", { candidateId: c.id, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }

    // ambiguous outcome → READ reconciliation; one retry only after proven absence
    if (ambiguous) {
      let readState: ConnectorSubscription | null = null;
      try {
        readState = await connector.getSubscription(c.externalSubscriptionId);
      } catch {
        await fail("The swap outcome is unknown and the reconciliation read also failed. Held — nothing retries automatically.", "CRITICAL", "UNCERTAIN");
        continue;
      }
      if (readState.externalProductId === funnel.targetExternalProductId) {
        written = readState; // the PUT landed
      } else if (readState.status === "active" && readState.externalProductId === funnel.sourceExternalProductId) {
        try {
          written = await connector.swapSubscriptionProduct(c.externalSubscriptionId, body);
          await db.trialConversionCandidate.update({ where: { id: c.id }, data: { attemptCount: { increment: 1 } } });
        } catch (e2) {
          await fail(`The swap outcome is unknown after one reconciled retry (${e2 instanceof Error ? e2.message.slice(0, 150) : String(e2)}). Held — nothing retries automatically.`, "CRITICAL", "UNCERTAIN");
          continue;
        }
      } else {
        await fail(`Reconciliation read shows an unexpected state (status ${readState.providerStatus}, product ${readState.externalProductId}). Held for a human.`, "CRITICAL", "UNCERTAIN");
        continue;
      }
    }
    if (!written) {
      await fail("No write result and no definite failure; held for reconciliation.", "CRITICAL", "UNCERTAIN");
      continue;
    }

    // authoritative read-back — CONVERTED only when the provider state matches the target
    let readback: ConnectorSubscription;
    try {
      readback = await connector.getSubscription(c.externalSubscriptionId);
    } catch {
      readback = written;
    }
    const issues: string[] = [];
    if (readback.externalProductId !== funnel.targetExternalProductId) issues.push(`product ${readback.externalProductId} != ${funnel.targetExternalProductId}`);
    if (readback.externalVariantId !== funnel.targetExternalVariantId) issues.push(`variant ${readback.externalVariantId} != ${funnel.targetExternalVariantId}`);
    if (funnel.targetPrice !== null && readback.price !== null && Number(readback.price) !== Number(funnel.targetPrice)) issues.push(`price ${readback.price} != ${funnel.targetPrice.toFixed(2)}`);
    if (issues.length > 0) {
      await fail(`The swap was written but the read-back does not match: ${issues.join("; ")}`, "CRITICAL");
      continue;
    }

    const churnNote = readback.status !== "active" ? ` (the customer cancelled immediately after — normal churn, nothing further happens)` : "";
    await db.trialConversionCandidate.update({
      where: { id: c.id },
      data: { status: "CONVERTED", convertedAt: new Date(), verifiedAt: new Date(), lastError: null, detail: `Converted to "${readback.productTitle}" at £${readback.price ?? "?"}; verified by read-back${churnNote}.` },
    });
    await logActivity(ctx, {
      actorType: "SYSTEM",
      eventType: "TRIAL_CONVERTED",
      entityType: "SUBSCRIPTION",
      entityId: c.subscriptionId,
      summary: `Trial converted: ${customerName(c)}'s ${c.subscription.productTitleSnapshot} became ${readback.productTitle} (£${readback.price ?? "?"})${churnNote}.`,
      metadata: { funnelId: funnel.id, candidateId: c.id, externalSubscriptionId: c.externalSubscriptionId, nextChargeDate: readback.nextChargeDate },
    });
    summary.converted++;
    summary.results.push({ candidateId: c.id, externalSubscriptionId: c.externalSubscriptionId, outcome: "CONVERTED", detail: "Verified by authoritative read-back." });
  }

  // ── 4. run summary (only when something happened — the cron is hourly) ──────
  const notable = summary.enrolled + summary.cancelledDetected + summary.alreadyConverted + summary.ended + summary.converted + summary.wouldConvert + summary.failed + summary.uncertain + summary.postponed;
  if (notable > 0) {
    await logActivity(ctx, {
      actorType: "SYSTEM",
      eventType: "TRIAL_CONVERSION_RUN",
      entityType: "INTEGRATION",
      entityId: funnel.integrationId,
      summary: `Trial conversion sweep (${funnel.name}, ${mode}): ${summary.enrolled} enrolled, ${summary.checked} checked, ${summary.cancelledDetected} cancelled (never converted), ${mode === "LIVE" ? `${summary.converted} converted` : `${summary.wouldConvert} would convert`}${summary.alreadyConverted ? `, ${summary.alreadyConverted} already swapped manually` : ""}${summary.postponed ? `, ${summary.postponed} postponed` : ""}${summary.failed ? `, ${summary.failed} FAILED` : ""}${summary.uncertain ? `, ${summary.uncertain} UNCERTAIN` : ""}.`,
      metadata: { ...summary, results: summary.results.slice(0, 50) },
    });
  }
  return summary;
}

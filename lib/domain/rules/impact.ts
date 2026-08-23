/**
 * Activation impact analysis — READ ONLY.
 *
 * For a (programme, cycle) milestone, walk the programme's subscriptions and
 * classify each under both eligibility scopes so a merchant can see, from real
 * data, what PER_SUBSCRIPTION vs CUSTOMER_PROGRAM would do. Nothing is written.
 *
 * Lifetime deliveries for CUSTOMER_PROGRAM are counted from distinct JourneyCycle
 * rows (journeyId + externalOrderId is unique, and every cycle row belongs to
 * exactly one journey), never from denormalised counters.
 */
import type { EligibilityScope } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import { buildProgramResolver, isResolved } from "@/lib/domain/programs/resolve";
import { evaluateJourneyEligibilityIgnoringMode, type IneligibilityReason } from "@/lib/domain/eligibility/evaluate";
import { qualifyForRule, type DisqualificationReason } from "@/lib/domain/eligibility/qualify";

export type ImpactRow = {
  subscriptionId: string;
  externalSubscriptionId: string;
  customerId: string | null;
  customerName: string;
  customerEmail: string | null;
  status: string;
  nextChargeDate: string | null;
  journeyId: string | null;
  successfulCycles: number | null;
  lifetimeDeliveries: number; // customer + programme, distinct cycle evidence
  otherJourneysInProgram: number; // other journeys (any subscription) of this customer in this programme
  eligibility: { eligible: boolean; reason?: IneligibilityReason; reasons: IneligibilityReason[] };
  perSubscription: { qualifies: boolean; reason?: DisqualificationReason; timing: string };
  customerProgram: { qualifies: boolean; reason?: DisqualificationReason; timing: string };
  /** classification bucket for the UI */
  bucket: ImpactBucket;
};

export type ImpactBucket =
  | "WOULD_QUALIFY_NOW"
  | "FUTURE_ONLY"
  | "ALREADY_PAST"
  | "NO_UPCOMING_CHARGE"
  | "CANCELLED_OR_INACTIVE"
  | "JOURNEY_ENDED"
  | "UNMAPPED_OR_BROKEN"
  | "OTHER_INELIGIBLE";

export type ImpactSummary = {
  programId: string;
  programName: string;
  cycleNumber: number;
  totalSubscriptions: number;
  active: number;
  atPreviousCycle: number; // successfulCycles === cycle-1 regardless of eligibility
  buckets: Record<ImpactBucket, number>;
  perSubscription: { qualifyNow: number; futureOnly: number; alreadyPast: number };
  customerProgram: { qualifyNow: number; futureOnly: number; alreadyPast: number; alreadyReachedViaOtherSubscription: number };
  /** subscriptions where the two scopes disagree */
  scopeDifferences: ImpactRow[];
  rows: ImpactRow[];
};

const EMPTY_BUCKETS: Record<ImpactBucket, number> = {
  WOULD_QUALIFY_NOW: 0,
  FUTURE_ONLY: 0,
  ALREADY_PAST: 0,
  NO_UPCOMING_CHARGE: 0,
  CANCELLED_OR_INACTIVE: 0,
  JOURNEY_ENDED: 0,
  UNMAPPED_OR_BROKEN: 0,
  OTHER_INELIGIBLE: 0,
};

function bucketFor(row: Pick<ImpactRow, "eligibility" | "perSubscription">): ImpactBucket {
  if (!row.eligibility.eligible) {
    const r = row.eligibility.reason!;
    if (r === "SUBSCRIPTION_NOT_ACTIVE") return "CANCELLED_OR_INACTIVE";
    if (r === "NO_UPCOMING_CHARGE") return "NO_UPCOMING_CHARGE";
    if (r === "JOURNEY_ENDED") return "JOURNEY_ENDED";
    if (r === "UNMAPPED" || r === "BROKEN_MAPPING" || r === "NO_JOURNEY") return "UNMAPPED_OR_BROKEN";
    return "OTHER_INELIGIBLE";
  }
  if (row.perSubscription.qualifies) return "WOULD_QUALIFY_NOW";
  if (row.perSubscription.reason === "NOT_NEXT_CYCLE") return "FUTURE_ONLY";
  if (row.perSubscription.reason === "MILESTONE_ALREADY_PASSED") return "ALREADY_PAST";
  return "OTHER_INELIGIBLE";
}

export async function analyzeMilestoneImpact(
  ctx: { organizationId: string },
  params: { programId: string; cycleNumber: number; ruleId?: string | null; fulfillmentMarkerId?: string | null },
): Promise<ImpactSummary> {
  const db = dbFor(ctx);
  const program = await db.subscriptionProgram.findUniqueOrThrow({ where: { id: params.programId }, select: { id: true, name: true } });

  // every subscription whose LATEST journey is in this programme (includes cancelled, for the full picture)
  const subs = await db.subscription.findMany({
    where: { latestJourney: { programId: program.id } },
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, email: true } },
      integration: { select: { id: true, status: true, automationMode: true } },
      latestJourney: { select: { id: true, programId: true, successfulCycles: true, endedAt: true } },
    },
    orderBy: [{ status: "asc" }, { externalCreatedAt: "asc" }],
  });

  // lifetime deliveries per (customer, programme) from distinct cycle evidence
  const customerIds = [...new Set(subs.map((s) => s.customerId).filter((x): x is string => !!x))];
  const cycleRows = await db.journeyCycle.findMany({
    where: { journey: { programId: program.id, subscription: { customerId: { in: customerIds } } } },
    select: { journeyId: true, externalOrderId: true, journey: { select: { subscription: { select: { customerId: true } } } } },
  });
  const lifetime = new Map<string, Set<string>>(); // customerId → set of journeyId:orderId
  const journeysPerCustomer = new Map<string, Set<string>>();
  for (const c of cycleRows) {
    const cid = c.journey.subscription.customerId;
    if (!cid) continue;
    if (!lifetime.has(cid)) lifetime.set(cid, new Set());
    lifetime.get(cid)!.add(`${c.journeyId}:${c.externalOrderId}`);
    if (!journeysPerCustomer.has(cid)) journeysPerCustomer.set(cid, new Set());
    journeysPerCustomer.get(cid)!.add(c.journeyId);
  }
  // journeys with zero cycles still count as "other journeys" for visibility
  const allJourneys = await db.subscriptionJourney.findMany({ where: { programId: program.id, subscription: { customerId: { in: customerIds } } }, select: { id: true, subscription: { select: { customerId: true } } } });
  for (const j of allJourneys) {
    const cid = j.subscription.customerId;
    if (!cid) continue;
    if (!journeysPerCustomer.has(cid)) journeysPerCustomer.set(cid, new Set());
    journeysPerCustomer.get(cid)!.add(j.id);
  }

  // live actions for this milestone (none in Phase 3, but the logic is permanent)
  const liveActions = await db.automationAction.findMany({
    where: { targetCycle: params.cycleNumber, status: { in: ["PLANNED", "EXECUTING", "ATTACHED", "FULFILLED", "FAILED"] }, journey: { programId: program.id }, ...(params.fulfillmentMarkerId ? { fulfillmentMarkerId: params.fulfillmentMarkerId } : {}) },
    select: { journeyId: true },
  });
  const journeysWithAction = new Set(liveActions.map((a) => a.journeyId));

  // resolver per integration (programme may span integrations; typically one)
  const resolvers = new Map<string, Awaited<ReturnType<typeof buildProgramResolver>>>();
  for (const s of subs) if (!resolvers.has(s.integrationId)) resolvers.set(s.integrationId, await buildProgramResolver(ctx, s.integrationId));

  const rule = { status: "ACTIVE" as const, programId: program.id, cycleNumber: params.cycleNumber, eligibilityScope: null };
  const rows: ImpactRow[] = [];
  for (const s of subs) {
    const res = resolvers.get(s.integrationId)!.resolve(s.externalProductId, s.externalVariantId);
    const eligibility = evaluateJourneyEligibilityIgnoringMode({
      subscription: { status: s.status, mappingStatus: s.mappingStatus, nextChargeDate: s.nextChargeDate, latestJourneyId: s.latestJourneyId, automationOverride: s.automationOverride },
      journey: s.latestJourney ? { id: s.latestJourney.id, endedAt: s.latestJourney.endedAt, programId: s.latestJourney.programId } : null,
      resolvedProgramId: isResolved(res) ? res.programId : null,
      integration: s.integration,
    });
    const lifetimeDeliveries = s.customerId ? (lifetime.get(s.customerId)?.size ?? 0) : (s.latestJourney?.successfulCycles ?? 0);
    const otherJourneys = s.customerId ? Math.max(0, (journeysPerCustomer.get(s.customerId)?.size ?? 0) - 1) : 0;
    const journey = { programId: s.latestJourney?.programId ?? "", successfulCycles: s.latestJourney?.successfulCycles ?? 0 };
    const existingLiveAction = s.latestJourney ? journeysWithAction.has(s.latestJourney.id) : false;
    const per = qualifyForRule({ rule, journey, existingLiveAction, ignoreRuleStatus: true, scopeOverride: "PER_SUBSCRIPTION" });
    const cust = qualifyForRule({ rule, journey, existingLiveAction, ignoreRuleStatus: true, scopeOverride: "CUSTOMER_PROGRAM", customerLifetimeDeliveries: lifetimeDeliveries });
    const row: ImpactRow = {
      subscriptionId: s.id,
      externalSubscriptionId: s.externalSubscriptionId,
      customerId: s.customerId,
      customerName: [s.customer?.firstName, s.customer?.lastName].filter(Boolean).join(" ") || s.customer?.email || "Unknown customer",
      customerEmail: s.customer?.email ?? null,
      status: s.status,
      nextChargeDate: s.nextChargeDate,
      journeyId: s.latestJourney?.id ?? null,
      successfulCycles: s.latestJourney?.successfulCycles ?? null,
      lifetimeDeliveries,
      otherJourneysInProgram: otherJourneys,
      eligibility: eligibility.eligible ? { eligible: true, reasons: [] } : { eligible: false, reason: eligibility.reason, reasons: eligibility.reasons },
      perSubscription: per.qualifies ? { qualifies: true, timing: per.timing } : { qualifies: false, reason: per.reason, timing: per.timing },
      customerProgram: cust.qualifies ? { qualifies: true, timing: cust.timing } : { qualifies: false, reason: cust.reason, timing: cust.timing },
      bucket: "OTHER_INELIGIBLE",
    };
    row.bucket = bucketFor(row);
    rows.push(row);
  }

  const buckets = { ...EMPTY_BUCKETS };
  for (const r of rows) buckets[r.bucket]++;
  const elig = rows.filter((r) => r.eligibility.eligible);
  const summary: ImpactSummary = {
    programId: program.id,
    programName: program.name,
    cycleNumber: params.cycleNumber,
    totalSubscriptions: rows.length,
    active: rows.filter((r) => r.status === "ACTIVE").length,
    atPreviousCycle: rows.filter((r) => r.successfulCycles === params.cycleNumber - 1).length,
    buckets,
    perSubscription: {
      qualifyNow: elig.filter((r) => r.perSubscription.qualifies).length,
      futureOnly: elig.filter((r) => r.perSubscription.reason === "NOT_NEXT_CYCLE").length,
      alreadyPast: elig.filter((r) => r.perSubscription.reason === "MILESTONE_ALREADY_PASSED").length,
    },
    customerProgram: {
      qualifyNow: elig.filter((r) => r.customerProgram.qualifies).length,
      futureOnly: elig.filter((r) => r.customerProgram.reason === "NOT_NEXT_CYCLE").length,
      alreadyPast: elig.filter((r) => r.customerProgram.reason === "MILESTONE_ALREADY_PASSED").length,
      alreadyReachedViaOtherSubscription: elig.filter((r) => r.customerProgram.reason === "CUSTOMER_ALREADY_REACHED_MILESTONE").length,
    },
    // only operationally eligible rows: a cancelled subscription "disagreeing" is moot and would read as noise
    scopeDifferences: rows.filter((r) => r.eligibility.eligible && (r.perSubscription.qualifies !== r.customerProgram.qualifies || r.perSubscription.reason !== r.customerProgram.reason)),
    rows,
  };
  return summary;
}

export type { EligibilityScope };

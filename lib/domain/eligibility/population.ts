/**
 * Programme population — the ONE loader used by both the rule impact analysis and the
 * action planner, so "what the preview says" and "what the planner does" can never
 * diverge: same subscriptions, same latest-journey view, same lifetime evidence.
 *
 * Lifetime deliveries are counted from DISTINCT JourneyCycle evidence per provider
 * customer + programme (every journey of that customer in the programme, including
 * cancelled and simultaneous ones) — never from summed counters.
 */
import type { AutomationMode, IntegrationStatus, MappingStatus, SubscriptionStatus } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import { buildProgramResolver, isResolved } from "@/lib/domain/programs/resolve";

export type PopulationRow = {
  subscriptionId: string;
  externalSubscriptionId: string;
  externalAddressId: string;
  externalCustomerId: string;
  integrationId: string;
  integration: { id: string; status: IntegrationStatus; automationMode: AutomationMode };
  customerId: string | null;
  customer: { id: string; firstName: string | null; lastName: string | null; email: string | null } | null;
  status: SubscriptionStatus;
  mappingStatus: MappingStatus;
  nextChargeDate: string | null;
  nextChargeAt: Date | null;
  automationOverride: "ENABLED" | "DISABLED" | null;
  latestJourneyId: string | null;
  latestJourney: { id: string; programId: string; successfulCycles: number; endedAt: Date | null } | null;
  /** the subscription's CURRENT product/variant resolved through the programme mappings (null = unresolvable) */
  resolvedProgramId: string | null;
  /** distinct successful deliveries of the same provider customer in this programme, across all journeys */
  lifetimeDeliveries: number;
  /** other journeys of the same customer in this programme (any subscription), for visibility */
  otherJourneysInProgram: number;
};

export type ProgramPopulation = {
  programId: string;
  programName: string;
  rows: PopulationRow[];
};

export async function loadProgramPopulation(
  ctx: { organizationId: string },
  programId: string,
  opts: { integrationId?: string } = {},
): Promise<ProgramPopulation> {
  const db = dbFor(ctx);
  const program = await db.subscriptionProgram.findUniqueOrThrow({ where: { id: programId }, select: { id: true, name: true } });

  // every subscription whose LATEST journey is in this programme (includes cancelled, for the full picture)
  const subs = await db.subscription.findMany({
    where: { latestJourney: { programId: program.id }, ...(opts.integrationId ? { integrationId: opts.integrationId } : {}) },
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, email: true } },
      integration: { select: { id: true, status: true, automationMode: true } },
      latestJourney: { select: { id: true, programId: true, successfulCycles: true, endedAt: true } },
    },
    orderBy: [{ status: "asc" }, { externalCreatedAt: "asc" }],
  });

  // lifetime deliveries per (customer, programme) from distinct cycle evidence — across ALL integrations
  // of the organisation (a provider customer is integration-scoped, so this is still per store)
  const customerIds = [...new Set(subs.map((s) => s.customerId).filter((x): x is string => !!x))];
  const cycleRows = customerIds.length
    ? await db.journeyCycle.findMany({
        where: { journey: { programId: program.id, subscription: { customerId: { in: customerIds } } } },
        select: { journeyId: true, externalOrderId: true, journey: { select: { subscription: { select: { customerId: true } } } } },
      })
    : [];
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
  const allJourneys = customerIds.length
    ? await db.subscriptionJourney.findMany({ where: { programId: program.id, subscription: { customerId: { in: customerIds } } }, select: { id: true, subscription: { select: { customerId: true } } } })
    : [];
  for (const j of allJourneys) {
    const cid = j.subscription.customerId;
    if (!cid) continue;
    if (!journeysPerCustomer.has(cid)) journeysPerCustomer.set(cid, new Set());
    journeysPerCustomer.get(cid)!.add(j.id);
  }

  // resolver per integration (a programme may span integrations; typically one)
  const resolvers = new Map<string, Awaited<ReturnType<typeof buildProgramResolver>>>();
  for (const s of subs) if (!resolvers.has(s.integrationId)) resolvers.set(s.integrationId, await buildProgramResolver(ctx, s.integrationId));

  const rows: PopulationRow[] = subs.map((s) => {
    const res = resolvers.get(s.integrationId)!.resolve(s.externalProductId, s.externalVariantId);
    return {
      subscriptionId: s.id,
      externalSubscriptionId: s.externalSubscriptionId,
      externalAddressId: s.externalAddressId,
      externalCustomerId: s.externalCustomerId,
      integrationId: s.integrationId,
      integration: s.integration,
      customerId: s.customerId,
      customer: s.customer,
      status: s.status,
      mappingStatus: s.mappingStatus,
      nextChargeDate: s.nextChargeDate,
      nextChargeAt: s.nextChargeAt,
      automationOverride: (s.automationOverride as "ENABLED" | "DISABLED" | null) ?? null,
      latestJourneyId: s.latestJourneyId,
      latestJourney: s.latestJourney,
      resolvedProgramId: isResolved(res) ? res.programId : null,
      lifetimeDeliveries: s.customerId ? (lifetime.get(s.customerId)?.size ?? 0) : (s.latestJourney?.successfulCycles ?? 0),
      otherJourneysInProgram: s.customerId ? Math.max(0, (journeysPerCustomer.get(s.customerId)?.size ?? 0) - 1) : 0,
    };
  });

  return { programId: program.id, programName: program.name, rows };
}

/** Display name helper shared by impact rows and planner decisions. */
export function populationCustomerName(r: Pick<PopulationRow, "customer">): string {
  return [r.customer?.firstName, r.customer?.lastName].filter(Boolean).join(" ") || r.customer?.email || "Unknown customer";
}

import "server-only";
import { dbFor } from "@/lib/db/tenant";
import type { OrgContext } from "@/lib/auth/tenancy";

type Ctx = Pick<OrgContext, "organizationId">;

export async function getIntegrationDetail(ctx: Ctx, integrationId: string) {
  const db = dbFor(ctx);
  const integration = await db.integration.findUnique({
    where: { id: integrationId },
    select: {
      id: true,
      provider: true,
      status: true,
      displayName: true,
      externalStoreId: true,
      automationMode: true,
      capabilitiesJson: true,
      capabilitiesCheckedAt: true,
      settingsJson: true,
      lastSuccessfulSyncAt: true,
      lastErrorAt: true,
      lastErrorMessage: true,
      createdAt: true,
      pairedIntegrationId: true,
      pairedIntegration: { select: { id: true, displayName: true, provider: true } },
    },
  });
  if (!integration) return null;
  const [syncs, stats, latestSync] = await Promise.all([
    db.integrationSync.findMany({ where: { integrationId }, orderBy: { createdAt: "desc" }, take: 20 }),
    getIntegrationStats(ctx, integrationId),
    db.integrationSync.findFirst({ where: { integrationId, status: { in: ["QUEUED", "RUNNING"] } }, orderBy: { createdAt: "desc" } }),
  ]);
  return { integration, syncs, stats, activeSync: latestSync };
}

export async function getIntegrationStats(ctx: Ctx, integrationId: string) {
  const db = dbFor(ctx);
  const [subscriptions, active, mappedActive, unmappedActive, customers, products, variants, orderLines, unlinkedOrderLines, programs] = await Promise.all([
    db.subscription.count({ where: { integrationId } }),
    db.subscription.count({ where: { integrationId, status: "ACTIVE" } }),
    db.subscription.count({ where: { integrationId, status: "ACTIVE", mappingStatus: "MAPPED" } }),
    db.subscription.count({ where: { integrationId, status: "ACTIVE", mappingStatus: "UNMAPPED" } }),
    db.customer.count({ where: { integrationId } }),
    db.product.count({ where: { integrationId } }),
    db.productVariant.count({ where: { product: { integrationId } } }),
    db.subscriptionOrder.count({ where: { integrationId } }),
    db.subscriptionOrder.count({ where: { integrationId, subscriptionId: null } }),
    db.subscriptionProgram.count({ where: { active: true } }),
  ]);
  const unmappedProducts = await db.product.count({ where: { integrationId, programProducts: { none: {} }, subscriptions: { some: { status: "ACTIVE" } } } });
  return { subscriptions, active, inactive: subscriptions - active, mappedActive, unmappedActive, customers, products, variants, orderLines, unlinkedOrderLines, programs, unmappedProducts };
}

/** Latest sync per integration, for the integrations overview cards. */
export async function getLatestSyncs(ctx: Ctx, integrationIds: string[]) {
  const db = dbFor(ctx);
  const syncs = await db.integrationSync.findMany({ where: { integrationId: { in: integrationIds } }, orderBy: { createdAt: "desc" } });
  const latest = new Map<string, (typeof syncs)[number]>();
  for (const s of syncs) if (!latest.has(s.integrationId)) latest.set(s.integrationId, s);
  return latest;
}

/**
 * Cycle audit sample: subscriptions with the most history, with their orders,
 * so an operator can compare "our cycle N" against Recharge order history by hand.
 */
export async function getCycleAuditSample(ctx: Ctx, integrationId: string, take = 10) {
  const db = dbFor(ctx);
  const subs = await db.subscription.findMany({
    where: { integrationId, status: "ACTIVE", mappingStatus: "MAPPED", latestJourneyId: { not: null } },
    orderBy: [{ latestJourney: { successfulCycles: "desc" } }, { externalCreatedAt: "asc" }],
    take,
    include: {
      customer: true,
      latestJourney: { include: { program: { select: { name: true } }, cycles: { orderBy: { cycleNumber: "asc" } } } },
      orders: { orderBy: { processedAt: "asc" } },
      journeys: { select: { id: true, sequence: true, successfulCycles: true, programId: true, endReason: true } },
    },
  });
  return subs;
}

import "server-only";
import { dbFor } from "@/lib/db/tenant";
import type { OrgContext } from "@/lib/auth/tenancy";

type Ctx = Pick<OrgContext, "organizationId">;

export async function listPrograms(ctx: Ctx) {
  const db = dbFor(ctx);
  const programs = await db.subscriptionProgram.findMany({
    orderBy: { name: "asc" },
    include: {
      products: { include: { product: { select: { id: true, title: true } }, variant: { select: { id: true, title: true, sku: true } } } },
      _count: { select: { rules: true } },
    },
  });
  const activeJourneys = await db.subscriptionJourney.groupBy({
    by: ["programId"],
    where: { endedAt: null, subscription: { status: "ACTIVE" } },
    _count: { _all: true },
  });
  const byProgram = new Map(activeJourneys.map((j) => [j.programId, j._count._all]));
  return programs.map((p) => ({ ...p, activeSubscriptions: byProgram.get(p.id) ?? 0 }));
}

export async function listSubscriptionProducts(ctx: Ctx) {
  const db = dbFor(ctx);
  return db.product.findMany({
    where: { type: "SUBSCRIPTION_PRODUCT" },
    orderBy: { title: "asc" },
    include: {
      variants: { orderBy: { title: "asc" } },
      programProducts: { include: { program: { select: { id: true, name: true } } } },
      _count: { select: { subscriptions: true } },
    },
  });
}

export async function listMarkers(ctx: Ctx) {
  const db = dbFor(ctx);
  const markers = await db.fulfillmentMarker.findMany({
    orderBy: { name: "asc" },
    include: {
      variant: { include: { product: { select: { id: true, title: true } } } },
      rules: { select: { id: true, name: true, enabled: true, cycleNumber: true, program: { select: { name: true } } } },
    },
  });
  const lastUsed = await db.automationAction.groupBy({
    by: ["fulfillmentMarkerId"],
    where: { status: { in: ["ATTACHED", "FULFILLED"] } },
    _max: { executedAt: true },
    _count: { _all: true },
  });
  const usage = new Map(lastUsed.map((u) => [u.fulfillmentMarkerId, { lastUsedAt: u._max.executedAt, uses: u._count._all }]));
  return markers.map((m) => ({ ...m, usage: usage.get(m.id) ?? { lastUsedAt: null, uses: 0 } }));
}

export async function countUnmappedSubscriptions(ctx: Ctx) {
  return dbFor(ctx).subscription.count({ where: { mappingStatus: "UNMAPPED", status: "ACTIVE" } });
}

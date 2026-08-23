import "server-only";
import type { ActionStatus, Prisma } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import type { OrgContext } from "@/lib/auth/tenancy";

type Ctx = Pick<OrgContext, "organizationId">;

export type UpcomingFilters = {
  status?: ActionStatus | "ALL" | "LIVE";
  programId?: string;
  markerId?: string;
  integrationId?: string;
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
};

const actionInclude = {
  subscription: { include: { customer: { select: { firstName: true, lastName: true, email: true } } } },
  journey: { include: { program: { select: { id: true, name: true } } } },
  fulfillmentMarker: { select: { id: true, name: true, title: true, sku: true, externalVariantId: true, placeholder: true } },
  rule: { select: { id: true, name: true, eligibilityScope: true, status: true, cycleNumber: true } },
  integration: { select: { id: true, displayName: true, automationMode: true } },
} satisfies Prisma.AutomationActionInclude;

export type UpcomingAction = Prisma.AutomationActionGetPayload<{ include: typeof actionInclude }>;

export async function listUpcomingActions(ctx: Ctx, filters: UpcomingFilters, now = new Date()) {
  const db = dbFor(ctx);
  const where: Prisma.AutomationActionWhereInput = {};
  if (!filters.status || filters.status === "LIVE") {
    where.status = { in: ["PLANNED", "EXECUTING", "ATTACHED", "FAILED"] };
  } else if (filters.status !== "ALL") {
    where.status = filters.status;
  }
  if (filters.programId) where.journey = { programId: filters.programId };
  if (filters.markerId) where.fulfillmentMarkerId = filters.markerId;
  if (filters.integrationId) where.integrationId = filters.integrationId;
  if (filters.from || filters.to) {
    where.targetChargeDate = { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) };
  } else if (!filters.status || filters.status === "LIVE") {
    // default window: yesterday onwards (so just-missed ones still show)
    where.targetChargeAt = { gte: new Date(now.getTime() - 86_400_000) };
  }

  const rows = await db.automationAction.findMany({
    where,
    orderBy: [{ targetChargeAt: "asc" }, { createdAt: "asc" }],
    take: 300,
    include: actionInclude,
  });

  const groups = new Map<string, UpcomingAction[]>();
  for (const r of rows) {
    const key = r.targetChargeDate ?? "unscheduled";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  return { rows, groups: [...groups.entries()] };
}

export async function getActionDetail(ctx: Ctx, id: string) {
  const db = dbFor(ctx);
  const action = await db.automationAction.findUnique({
    where: { id },
    include: {
      ...actionInclude,
      journey: { include: { program: { select: { id: true, name: true } }, cycles: { orderBy: { cycleNumber: "asc" } } } },
      plannerRun: { select: { id: true, trigger: true, startedAt: true, automationMode: true } },
    },
  });
  if (!action) return null;
  const activity = await db.activityLog.findMany({ where: { entityType: "ACTION", entityId: id }, orderBy: { createdAt: "desc" }, take: 50 });
  return { action, activity };
}

export async function listPlannerRuns(ctx: Ctx, opts: { integrationId?: string; take?: number } = {}) {
  return dbFor(ctx).plannerRun.findMany({
    where: opts.integrationId ? { integrationId: opts.integrationId } : {},
    orderBy: { startedAt: "desc" },
    take: opts.take ?? 10,
    include: { integration: { select: { id: true, displayName: true } } },
  });
}

export async function listIntegrationsForAutomation(ctx: Ctx) {
  const db = dbFor(ctx);
  const integrations = await db.integration.findMany({
    where: { status: { not: "DISCONNECTED" } },
    select: { id: true, displayName: true, status: true, automationMode: true, lastSuccessfulSyncAt: true },
    orderBy: { createdAt: "asc" },
  });
  const runs = await db.plannerRun.findMany({ where: { integrationId: { in: integrations.map((i) => i.id) } }, orderBy: { startedAt: "desc" }, distinct: ["integrationId"] });
  const live = await db.automationAction.groupBy({ by: ["integrationId", "status"], _count: { _all: true }, where: { integrationId: { in: integrations.map((i) => i.id) } } });
  return integrations.map((i) => ({
    ...i,
    lastPlannerRun: runs.find((r) => r.integrationId === i.id) ?? null,
    counts: Object.fromEntries(live.filter((l) => l.integrationId === i.id).map((l) => [l.status, l._count._all])) as Partial<Record<ActionStatus, number>>,
  }));
}

export async function listMarkersForFilter(ctx: Ctx) {
  return dbFor(ctx).fulfillmentMarker.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });
}

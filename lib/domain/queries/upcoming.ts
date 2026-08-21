import "server-only";
import type { ActionStatus, Prisma } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import type { OrgContext } from "@/lib/auth/tenancy";

type Ctx = Pick<OrgContext, "organizationId">;

export type UpcomingFilters = {
  status?: ActionStatus | "ALL" | "LIVE";
  programId?: string;
  markerId?: string;
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
};

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
  if (filters.from || filters.to) {
    where.targetChargeDate = {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lte: filters.to } : {}),
    };
  } else if (!filters.status || filters.status === "LIVE") {
    // default window: yesterday onwards (so just-missed ones still show)
    where.targetChargeAt = { gte: new Date(now.getTime() - 86_400_000) };
  }

  const rows = await db.automationAction.findMany({
    where,
    orderBy: [{ targetChargeAt: "asc" }, { createdAt: "asc" }],
    take: 200,
    include: {
      subscription: { include: { customer: true } },
      journey: { include: { program: { select: { id: true, name: true } } } },
      fulfillmentMarker: { select: { id: true, name: true } },
      rule: { select: { id: true, name: true } },
    },
  });

  // group by target charge date (string, merchant-local date)
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.targetChargeDate ?? "unscheduled";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  return { rows, groups: [...groups.entries()] };
}

export async function listMarkersForFilter(ctx: Ctx) {
  return dbFor(ctx).fulfillmentMarker.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });
}

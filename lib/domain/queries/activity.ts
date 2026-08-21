import "server-only";
import type { EntityType, Prisma } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import type { OrgContext } from "@/lib/auth/tenancy";

type Ctx = Pick<OrgContext, "organizationId">;

export const ACTIVITY_PAGE_SIZE = 50;

export type ActivityFilters = { entityType?: EntityType | "ALL"; q?: string; page?: number };

export async function listActivity(ctx: Ctx, filters: ActivityFilters) {
  const db = dbFor(ctx);
  const page = Math.max(1, filters.page ?? 1);
  const where: Prisma.ActivityLogWhereInput = {};
  if (filters.entityType && filters.entityType !== "ALL") where.entityType = filters.entityType;
  if (filters.q?.trim()) where.summary = { contains: filters.q.trim(), mode: "insensitive" };
  const [total, rows] = await Promise.all([
    db.activityLog.count({ where }),
    db.activityLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * ACTIVITY_PAGE_SIZE,
      take: ACTIVITY_PAGE_SIZE,
    }),
  ]);
  return { rows, total, page, pages: Math.max(1, Math.ceil(total / ACTIVITY_PAGE_SIZE)) };
}

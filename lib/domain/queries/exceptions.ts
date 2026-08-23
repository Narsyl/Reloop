import "server-only";
import type { ExceptionSeverity, ExceptionStatus, Prisma } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import type { OrgContext } from "@/lib/auth/tenancy";

type Ctx = Pick<OrgContext, "organizationId">;

export type ExceptionFilters = { status?: ExceptionStatus | "ALL"; severity?: ExceptionSeverity | "ALL" };

export async function listExceptions(ctx: Ctx, filters: ExceptionFilters) {
  const db = dbFor(ctx);
  const where: Prisma.ExceptionWhereInput = {};
  where.status = filters.status && filters.status !== "ALL" ? filters.status : "OPEN";
  if (filters.severity && filters.severity !== "ALL") where.severity = filters.severity;
  const rows = await db.exception.findMany({
    where,
    orderBy: [{ severity: "desc" }, { detectedAt: "desc" }],
    take: 200,
    include: {
      subscription: { include: { customer: true } },
      action: { include: { rewardItem: { select: { name: true } }, fulfillmentMarker: { select: { name: true } } } },
      rule: { select: { id: true, name: true } },
      integration: { select: { id: true, displayName: true } },
    },
  });
  const counts = await db.exception.groupBy({ by: ["status", "severity"], _count: { _all: true } });
  return { rows, counts };
}

import "server-only";
import { cache } from "react";
import { dbFor } from "@/lib/db/tenant";
import type { OrgContext } from "@/lib/auth/tenancy";

type Ctx = Pick<OrgContext, "organizationId">;

export const getNavCounts = cache(async (ctx: Ctx) => {
  const db = dbFor(ctx);
  const openExceptions = await db.exception.count({ where: { status: "OPEN", severity: { in: ["WARNING", "CRITICAL"] } } });
  return { openExceptions };
});

export async function getOverview(ctx: Ctx, now = new Date()) {
  const db = dbFor(ctx);
  const in7 = new Date(now.getTime() + 7 * 86_400_000);
  const ago30 = new Date(now.getTime() - 30 * 86_400_000);

  const [integrations, activeSubscriptions, actionsNext7, succeeded30, openExceptions, upcoming, recentActivity, exceptions] =
    await Promise.all([
      db.integration.count({ where: { status: { not: "DISCONNECTED" } } }),
      db.subscription.count({ where: { status: "ACTIVE" } }),
      db.automationAction.count({
        where: { status: { in: ["PLANNED", "EXECUTING", "ATTACHED"] }, targetChargeAt: { gte: now, lte: in7 } },
      }),
      db.automationAction.count({ where: { status: { in: ["ATTACHED", "FULFILLED"] }, executedAt: { gte: ago30 } } }),
      db.exception.count({ where: { status: "OPEN" } }),
      db.automationAction.findMany({
        where: { status: { in: ["PLANNED", "EXECUTING", "ATTACHED", "FAILED"] }, targetChargeAt: { gte: new Date(now.getTime() - 86_400_000) } },
        orderBy: [{ targetChargeAt: "asc" }],
        take: 8,
        include: {
          subscription: { include: { customer: true } },
          journey: { include: { program: true } },
          rewardItem: { select: { id: true, name: true } },
          fulfillmentMarker: true,
        },
      }),
      db.activityLog.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
      db.exception.findMany({
        where: { status: "OPEN" },
        orderBy: [{ severity: "desc" }, { detectedAt: "desc" }],
        take: 5,
        include: { subscription: { include: { customer: true } } },
      }),
    ]);

  return {
    hasIntegration: integrations > 0,
    metrics: { activeSubscriptions, actionsNext7, succeeded30, openExceptions },
    upcoming,
    recentActivity,
    exceptions,
  };
}

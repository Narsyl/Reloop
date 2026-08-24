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

const ACTION_INCLUDE = {
  subscription: { include: { customer: true } },
  journey: { include: { program: true } },
  rewardItem: { select: { id: true, name: true } },
  fulfillmentMarker: true,
} as const;

/** Actions whose latest rehearsal failed, or that failed outright. Mirrors the Upcoming "Needs review" definition. */
const REVIEW_WHERE = {
  OR: [{ status: "FAILED" as const }, { status: "PLANNED" as const, wouldExecute: false }],
};

export async function getOverview(ctx: Ctx, now = new Date()) {
  const db = dbFor(ctx);
  const in7 = new Date(now.getTime() + 7 * 86_400_000);
  const ago30 = new Date(now.getTime() - 30 * 86_400_000);

  const [integration, activeSubscriptions, giftsNext7, added30, reviewCount, openExceptions, reviewActions, exceptions, nextGifts, recentActivity] =
    await Promise.all([
      db.integration.findFirst({
        where: { status: { not: "DISCONNECTED" } },
        orderBy: { createdAt: "asc" },
        select: { id: true, provider: true, status: true, automationMode: true, lastSuccessfulSyncAt: true },
      }),
      db.subscription.count({ where: { status: "ACTIVE" } }),
      db.automationAction.count({
        where: { status: { in: ["PLANNED", "EXECUTING", "ATTACHED"] }, targetChargeAt: { gte: now, lte: in7 } },
      }),
      db.automationAction.count({ where: { status: { in: ["ATTACHED", "FULFILLED"] }, executedAt: { gte: ago30 } } }),
      db.automationAction.count({ where: REVIEW_WHERE }),
      db.exception.count({ where: { status: "OPEN" } }),
      db.automationAction.findMany({
        where: REVIEW_WHERE,
        orderBy: [{ targetChargeAt: "asc" }],
        take: 3,
        include: ACTION_INCLUDE,
      }),
      db.exception.findMany({
        where: { status: "OPEN" },
        orderBy: [{ severity: "desc" }, { detectedAt: "desc" }],
        take: 3,
        include: { subscription: { include: { customer: true } } },
      }),
      db.automationAction.findMany({
        where: {
          status: { in: ["PLANNED", "EXECUTING", "ATTACHED"] },
          NOT: { status: "PLANNED", wouldExecute: false },
          targetChargeAt: { gte: new Date(now.getTime() - 86_400_000) },
        },
        orderBy: [{ targetChargeAt: "asc" }],
        take: 6,
        include: ACTION_INCLUDE,
      }),
      db.activityLog.findMany({ orderBy: { createdAt: "desc" }, take: 6 }),
    ]);

  return {
    integration,
    metrics: { activeSubscriptions, giftsNext7, added30, reviewCount, openExceptions },
    reviewActions,
    exceptions,
    nextGifts,
    recentActivity,
  };
}

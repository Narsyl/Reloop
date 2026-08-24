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

/**
 * Subscription movement for the trend card: starts and cancellations in the
 * chosen window, the previous window of the same length for the delta, and the
 * products with the most active subscriptions. Read only.
 */
export async function getSubscriptionTrends(ctx: Ctx, days: 7 | 30, now = new Date()) {
  const db = dbFor(ctx);
  const start = new Date(now.getTime() - days * 86_400_000);
  const prevStart = new Date(now.getTime() - 2 * days * 86_400_000);
  const [started, startedPrev, cancelled, cancelledPrev, byProduct] = await Promise.all([
    db.subscription.count({ where: { externalCreatedAt: { gte: start, lte: now } } }),
    db.subscription.count({ where: { externalCreatedAt: { gte: prevStart, lt: start } } }),
    db.subscription.count({ where: { cancelledAt: { gte: start, lte: now } } }),
    db.subscription.count({ where: { cancelledAt: { gte: prevStart, lt: start } } }),
    db.subscription.findMany({
      where: { status: "ACTIVE" },
      select: { productTitleSnapshot: true, latestJourney: { select: { program: { select: { name: true } } } } },
    }),
  ]);
  // One line per product family (display only). Programme membership decides the
  // family where it exists; otherwise the family is derived from the product
  // title by dropping sizes, dash qualifiers and generic commerce words, so
  // "Turkey Tail Mushroom Extract - For Pets" lands in "Turkey Tail" and every
  // Lion's Mane variant lands together whether or not it is mapped yet.
  const merged = new Map<string, { title: string; count: number; fromProgram: boolean }>();
  for (const s of byProduct) {
    const program = s.latestJourney?.program.name ?? null;
    const source = program ?? s.productTitleSnapshot;
    const key = productFamilyKey(source);
    const row = merged.get(key);
    if (row) {
      row.count += 1;
      if (program && !row.fromProgram) {
        row.title = program;
        row.fromProgram = true;
      }
    } else {
      merged.set(key, { title: program ?? titleCase(key), count: 1, fromProgram: !!program });
    }
  }
  return {
    days,
    started,
    startedPrev,
    cancelled,
    cancelledPrev,
    topProducts: [...merged.values()].sort((a, b) => b.count - a.count).slice(0, 8),
  };
}

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

/** Words that never distinguish one product family from another. */
const GENERIC_TITLE_WORDS = new Set([
  "mushroom", "mushrooms", "extract", "powder", "coffee", "resin", "chunks", "chunk",
  "k-cups", "kcups", "cups", "ceremonial", "grade", "pure", "himalayan", "organic",
  "decaf", "gold", "latte", "tea", "for", "pets", "the", "and", "with",
]);

/** Normalises a product or programme name to its family key, e.g. "Turkey Tail". */
function productFamilyKey(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .split(" - ")[0]
    .replace(/['\u2019]/g, "");
  const words = cleaned.split(/\s+/).filter((w) => w && !GENERIC_TITLE_WORDS.has(w));
  return words.join(" ") || cleaned.trim() || name.toLowerCase();
}

function titleCase(key: string): string {
  return key.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

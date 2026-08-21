import "server-only";
import type { Prisma, SubscriptionStatus } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import type { OrgContext } from "@/lib/auth/tenancy";

type Ctx = Pick<OrgContext, "organizationId">;

export const SUBSCRIPTION_PAGE_SIZE = 25;

export type SubscriptionFilters = {
  q?: string;
  status?: SubscriptionStatus | "ALL";
  programId?: string;
  mapping?: "MAPPED" | "UNMAPPED" | "ALL";
  nextAction?: "ANY" | "NONE" | "ALL";
  page?: number;
};

export async function listSubscriptions(ctx: Ctx, filters: SubscriptionFilters) {
  const db = dbFor(ctx);
  const page = Math.max(1, filters.page ?? 1);
  const where: Prisma.SubscriptionWhereInput = {};

  if (filters.status && filters.status !== "ALL") where.status = filters.status;
  if (filters.programId) where.currentJourney = { programId: filters.programId };
  if (filters.mapping && filters.mapping !== "ALL") where.mappingStatus = filters.mapping;
  if (filters.q?.trim()) {
    const q = filters.q.trim();
    where.OR = [
      { externalSubscriptionId: { contains: q } },
      { productTitleSnapshot: { contains: q, mode: "insensitive" } },
      { skuSnapshot: { contains: q, mode: "insensitive" } },
      { customer: { email: { contains: q, mode: "insensitive" } } },
      { customer: { firstName: { contains: q, mode: "insensitive" } } },
      { customer: { lastName: { contains: q, mode: "insensitive" } } },
    ];
  }
  if (filters.nextAction === "ANY") {
    where.actions = { some: { status: { in: ["PLANNED", "EXECUTING", "ATTACHED"] } } };
  } else if (filters.nextAction === "NONE") {
    where.actions = { none: { status: { in: ["PLANNED", "EXECUTING", "ATTACHED"] } } };
  }

  const [total, rows] = await Promise.all([
    db.subscription.count({ where }),
    db.subscription.findMany({
      where,
      orderBy: [{ nextChargeAt: "asc" }, { createdAt: "desc" }],
      skip: (page - 1) * SUBSCRIPTION_PAGE_SIZE,
      take: SUBSCRIPTION_PAGE_SIZE,
      include: {
        customer: true,
        integration: { select: { id: true, displayName: true, provider: true } },
        currentJourney: { include: { program: { select: { id: true, name: true } } } },
        actions: {
          where: { status: { in: ["PLANNED", "EXECUTING", "ATTACHED", "FAILED"] } },
          orderBy: { targetChargeAt: "asc" },
          take: 1,
          include: { fulfillmentMarker: { select: { name: true } } },
        },
      },
    }),
  ]);

  return { rows, total, page, pageSize: SUBSCRIPTION_PAGE_SIZE, pages: Math.max(1, Math.ceil(total / SUBSCRIPTION_PAGE_SIZE)) };
}

export async function listProgramsForFilter(ctx: Ctx) {
  return dbFor(ctx).subscriptionProgram.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });
}

export async function getSubscriptionDetail(ctx: Ctx, id: string) {
  const db = dbFor(ctx);
  const subscription = await db.subscription.findUnique({
    where: { id },
    include: {
      customer: true,
      integration: { select: { id: true, displayName: true, provider: true, automationMode: true } },
      product: { select: { id: true, title: true } },
      variant: { select: { id: true, title: true, sku: true } },
      currentJourney: { include: { program: true, cycles: { orderBy: { cycleNumber: "asc" } } } },
      journeys: {
        orderBy: { sequence: "asc" },
        include: { program: true, cycles: { orderBy: { cycleNumber: "asc" } } },
      },
      orders: { orderBy: { processedAt: "asc" } },
      actions: {
        orderBy: [{ targetChargeAt: "desc" }, { createdAt: "desc" }],
        include: { fulfillmentMarker: true, rule: { select: { id: true, name: true } }, journey: { select: { id: true, sequence: true } } },
      },
      exceptions: { where: { status: "OPEN" }, orderBy: { detectedAt: "desc" } },
    },
  });
  if (!subscription) return null;
  const activity = await db.activityLog.findMany({
    where: {
      OR: [
        { entityType: "SUBSCRIPTION", entityId: id },
        { entityType: "JOURNEY", entityId: { in: subscription.journeys.map((j) => j.id) } },
        { entityType: "ACTION", entityId: { in: subscription.actions.map((a) => a.id) } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return { subscription, activity };
}

import "server-only";
import { dbFor } from "@/lib/db/tenant";
import { prisma } from "@/lib/db/prisma";
import type { OrgContext } from "@/lib/auth/tenancy";

type Ctx = Pick<OrgContext, "organizationId">;

export async function getOrganizationSettings(ctx: Ctx) {
  return prisma.organization.findUniqueOrThrow({
    where: { id: ctx.organizationId },
    select: { id: true, name: true, slug: true, timezone: true, currency: true, markerLeadHours: true, createdAt: true },
  });
}

export async function listTeam(ctx: Ctx) {
  return dbFor(ctx).organizationMembership.findMany({
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    include: { user: { select: { id: true, name: true, email: true, image: true } } },
  });
}

export async function listIntegrations(ctx: Ctx) {
  return dbFor(ctx).integration.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      provider: true,
      status: true,
      displayName: true,
      externalStoreId: true,
      automationMode: true,
      capabilitiesJson: true,
      capabilitiesCheckedAt: true,
      lastSuccessfulSyncAt: true,
      lastErrorAt: true,
      lastErrorMessage: true,
      createdAt: true,
      pairedIntegrationId: true,
      settingsJson: true,
      _count: { select: { subscriptions: true, products: true, customers: true, shopifyMarkers: true, fulfillmentMarkers: true } },
    },
  });
}

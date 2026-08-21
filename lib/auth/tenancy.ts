import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import type { OrganizationRole } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getSession, requireUser } from "@/lib/auth/session";

/**
 * The tenant context every domain function receives as its first argument.
 * Built only here, from the session + a verified membership row.
 */
export type OrgContext = {
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  timezone: string;
  currency: string;
  userId: string;
  role: OrganizationRole;
};

const ROLE_RANK: Record<OrganizationRole, number> = {
  VIEWER: 0,
  OPERATOR: 1,
  ADMIN: 2,
  OWNER: 3,
};

export function hasRole(ctx: OrgContext, minimum: OrganizationRole): boolean {
  return ROLE_RANK[ctx.role] >= ROLE_RANK[minimum];
}

/** Memberships for the signed-in user (for the org switcher). */
export const listMemberships = cache(async () => {
  const session = await getSession();
  if (!session) return [];
  return prisma.organizationMembership.findMany({
    where: { userId: session.user.id },
    include: { organization: { select: { id: true, name: true, slug: true } } },
    orderBy: { createdAt: "asc" },
  });
});

/**
 * Resolve the current organisation for this request.
 *  - not signed in            → redirect /login
 *  - no memberships           → redirect /onboarding
 *  - no/invalid active org    → fall back to the first membership and persist it
 * Membership is re-verified on every call; the session value is only a preference.
 */
export const getOrgContext = cache(async (): Promise<OrgContext | null> => {
  const session = await getSession();
  if (!session) return null;

  const [sessionRow, memberships] = await Promise.all([
    prisma.session.findUnique({
      where: { id: session.sessionId },
      select: { activeOrganizationId: true },
    }),
    prisma.organizationMembership.findMany({
      where: { userId: session.user.id },
      include: { organization: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  if (memberships.length === 0) return null;

  let membership =
    memberships.find((m) => m.organizationId === sessionRow?.activeOrganizationId) ?? null;
  if (!membership) {
    membership = memberships[0];
    await prisma.session.update({
      where: { id: session.sessionId },
      data: { activeOrganizationId: membership.organizationId },
    });
  }

  return {
    organizationId: membership.organizationId,
    organizationSlug: membership.organization.slug,
    organizationName: membership.organization.name,
    timezone: membership.organization.timezone,
    currency: membership.organization.currency,
    userId: session.user.id,
    role: membership.role,
  };
});

export async function requireOrg(): Promise<OrgContext> {
  await requireUser();
  const ctx = await getOrgContext();
  if (!ctx) redirect("/onboarding");
  return ctx;
}

export class ForbiddenError extends Error {
  constructor(message = "You do not have permission to do that.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export async function requireRole(minimum: OrganizationRole): Promise<OrgContext> {
  const ctx = await requireOrg();
  if (!hasRole(ctx, minimum)) throw new ForbiddenError();
  return ctx;
}

/**
 * Switch the active organisation. Verifies membership first; never trusts the
 * requested id on its own.
 */
export async function setActiveOrganization(organizationId: string): Promise<void> {
  const session = await requireUser();
  const membership = await prisma.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId, userId: session.user.id } },
    select: { id: true },
  });
  if (!membership) throw new ForbiddenError("You are not a member of that organisation.");
  await prisma.session.update({
    where: { id: session.sessionId },
    data: { activeOrganizationId: organizationId },
  });
}

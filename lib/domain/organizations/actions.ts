"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { requireUser } from "@/lib/auth/session";
import { ForbiddenError, requireRole, setActiveOrganization } from "@/lib/auth/tenancy";
import { slugify } from "@/lib/format";
import { logActivity } from "@/lib/domain/activity/log";

export type ActionResult<T = undefined> =
  | { ok: true; data?: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

const createOrganizationSchema = z.object({
  name: z.string().trim().min(2, "Give the organisation a name (at least 2 characters).").max(80),
  timezone: z.string().trim().min(1).default("Europe/London"),
  currency: z.string().trim().length(3).default("GBP"),
});

/**
 * Create an organisation and make the current user its OWNER, then make it the
 * active organisation. Uses the raw client deliberately: there is no org context
 * yet at this point.
 */
export async function createOrganization(input: unknown): Promise<ActionResult<{ id: string; slug: string }>> {
  const session = await requireUser();
  const parsed = createOrganizationSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Please check the form.", fieldErrors: z.flattenError(parsed.error).fieldErrors };
  }
  const { name, timezone, currency } = parsed.data;

  const base = slugify(name) || "organisation";
  let slug = base;
  for (let i = 2; i < 50; i++) {
    const exists = await prisma.organization.findUnique({ where: { slug }, select: { id: true } });
    if (!exists) break;
    slug = `${base}-${i}`;
  }

  try {
    const org = await prisma.$transaction(async (tx) => {
      const created = await tx.organization.create({ data: { name, slug, timezone, currency } });
      await tx.organizationMembership.create({
        data: { organizationId: created.id, userId: session.user.id, role: "OWNER" },
      });
      await tx.activityLog.create({
        data: {
          organizationId: created.id,
          actorType: "USER",
          actorId: session.user.id,
          eventType: "ORGANIZATION_CREATED",
          entityType: "ORGANIZATION",
          entityId: created.id,
          summary: `Organisation "${name}" created`,
        },
      });
      return created;
    });
    await setActiveOrganization(org.id);
    return { ok: true, data: { id: org.id, slug: org.slug } };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "An organisation with that name already exists. Try another name." };
    }
    throw e;
  }
}

/** Form-action wrapper for the onboarding page. */
export async function createOrganizationAndContinue(formData: FormData) {
  const result = await createOrganization({
    name: formData.get("name"),
    timezone: formData.get("timezone") || "Europe/London",
    currency: formData.get("currency") || "GBP",
  });
  if (!result.ok) {
    redirect(`/onboarding?error=${encodeURIComponent(result.error)}`);
  }
  redirect("/overview");
}

export async function switchOrganization(organizationId: string): Promise<ActionResult> {
  try {
    await setActiveOrganization(organizationId);
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: e.message };
    throw e;
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

const updateSettingsSchema = z.object({
  name: z.string().trim().min(2).max(80),
  timezone: z.string().trim().min(1),
  currency: z.string().trim().length(3).toUpperCase(),
  markerLeadHours: z.coerce.number().int().min(1).max(24 * 14),
});

export async function updateOrganizationSettings(input: unknown): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireRole("ADMIN");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: e.message };
    throw e;
  }
  const parsed = updateSettingsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Please check the form.", fieldErrors: z.flattenError(parsed.error).fieldErrors };
  }
  await prisma.organization.update({ where: { id: ctx.organizationId }, data: parsed.data });
  await logActivity(ctx, {
    actorType: "USER",
    actorId: ctx.userId,
    eventType: "ORGANIZATION_SETTINGS_UPDATED",
    entityType: "ORGANIZATION",
    entityId: ctx.organizationId,
    summary: "Organisation settings updated",
    metadata: parsed.data,
  });
  revalidatePath("/settings/general");
  revalidatePath("/", "layout");
  return { ok: true };
}

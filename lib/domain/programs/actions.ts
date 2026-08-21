"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import { ForbiddenError, requireRole } from "@/lib/auth/tenancy";
import { logActivity } from "@/lib/domain/activity/log";
import { inngest, journeysRecalculateRequested } from "@/lib/jobs/inngest";
import type { ActionResult } from "@/lib/domain/organizations/actions";

function friendlyMappingError(e: unknown): string | null {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("PROGRAM_MAPPING_AMBIGUOUS")) {
    if (msg.includes("variant-specific")) return "This product already has variant-specific program mappings. Remove those first if you want to map all variants to one program.";
    return "This product is already mapped for all variants. Remove that mapping first if you want to map specific variants.";
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
    return "That product/variant is already mapped to a program. A product or variant can belong to only one program.";
  }
  return null;
}

async function enqueueRecalc(organizationId: string, integrationId: string, reason: string) {
  await inngest.send(journeysRecalculateRequested.create({ organizationId, integrationId, reason }));
}

const programSchema = z.object({
  name: z.string().trim().min(2, "Give the program a name.").max(80),
  description: z.string().trim().max(300).optional().or(z.literal("")),
});

export async function createProgram(input: unknown): Promise<ActionResult<{ id: string }>> {
  let ctx;
  try {
    ctx = await requireRole("ADMIN");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: e.message };
    throw e;
  }
  const parsed = programSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Please check the form.", fieldErrors: z.flattenError(parsed.error).fieldErrors };
  try {
    const program = await dbFor(ctx).subscriptionProgram.create({ data: { organizationId: ctx.organizationId, name: parsed.data.name, description: parsed.data.description || null } });
    await logActivity(ctx, { actorType: "USER", actorId: ctx.userId, eventType: "PROGRAM_CREATED", entityType: "PROGRAM", entityId: program.id, summary: `Subscription program "${program.name}" created` });
    revalidatePath("/products");
    return { ok: true, data: { id: program.id } };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, error: "A program with that name already exists." };
    throw e;
  }
}

const updateSchema = programSchema.extend({ id: z.string().min(1), active: z.boolean().optional() });

export async function updateProgram(input: unknown): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireRole("ADMIN");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: e.message };
    throw e;
  }
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Please check the form.", fieldErrors: z.flattenError(parsed.error).fieldErrors };
  const db = dbFor(ctx);
  const existing = await db.subscriptionProgram.findUnique({ where: { id: parsed.data.id }, select: { id: true, name: true } });
  if (!existing) return { ok: false, error: "Program not found." };
  await db.subscriptionProgram.update({ where: { id: parsed.data.id }, data: { name: parsed.data.name, description: parsed.data.description || null, active: parsed.data.active ?? undefined } });
  await logActivity(ctx, { actorType: "USER", actorId: ctx.userId, eventType: "PROGRAM_UPDATED", entityType: "PROGRAM", entityId: existing.id, summary: `Subscription program "${parsed.data.name}" updated` });
  revalidatePath("/products");
  return { ok: true };
}

const assignSchema = z.object({
  programId: z.string().min(1),
  productId: z.string().min(1),
  /** "ALL" = all variants (one wildcard mapping); otherwise explicit variant ids */
  variantIds: z.union([z.literal("ALL"), z.array(z.string().min(1)).min(1)]),
});

/**
 * Map a product (all variants) or specific variants to a program.
 * The database trigger rejects any combination that would make resolution
 * ambiguous; we translate that into a clear message. On success, journeys are
 * recalculated for the product's integration.
 */
export async function assignProductToProgram(input: unknown): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireRole("ADMIN");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: e.message };
    throw e;
  }
  const parsed = assignSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const { programId, productId, variantIds } = parsed.data;
  const db = dbFor(ctx);
  const [program, product] = await Promise.all([
    db.subscriptionProgram.findUnique({ where: { id: programId }, select: { id: true, name: true } }),
    db.product.findUnique({ where: { id: productId }, select: { id: true, title: true, integrationId: true, variants: { select: { id: true, title: true } } } }),
  ]);
  if (!program) return { ok: false, error: "Program not found." };
  if (!product) return { ok: false, error: "Product not found." };
  const wanted = variantIds === "ALL" ? null : product.variants.filter((v) => variantIds.includes(v.id));
  if (wanted && wanted.length !== variantIds.length) return { ok: false, error: "One or more variants do not belong to this product." };

  try {
    if (wanted === null) {
      await db.subscriptionProgramProduct.create({ data: { organizationId: ctx.organizationId, programId, productId, variantId: null, variantScope: "*" } });
    } else {
      for (const v of wanted) {
        await db.subscriptionProgramProduct.create({ data: { organizationId: ctx.organizationId, programId, productId, variantId: v.id, variantScope: v.id } });
      }
    }
  } catch (e) {
    const friendly = friendlyMappingError(e);
    if (friendly) return { ok: false, error: friendly };
    throw e;
  }
  await logActivity(ctx, {
    actorType: "USER",
    actorId: ctx.userId,
    eventType: "PROGRAM_PRODUCT_MAPPED",
    entityType: "PROGRAM",
    entityId: programId,
    summary: wanted === null ? `Mapped "${product.title}" (all variants) to program "${program.name}"` : `Mapped ${wanted.length} variant${wanted.length === 1 ? "" : "s"} of "${product.title}" to program "${program.name}"`,
  });
  await enqueueRecalc(ctx.organizationId, product.integrationId, "mapping_added");
  revalidatePath("/products");
  revalidatePath("/subscriptions");
  return { ok: true };
}

export async function removeProgramMapping(mappingId: string): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireRole("ADMIN");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: e.message };
    throw e;
  }
  const db = dbFor(ctx);
  const mapping = await db.subscriptionProgramProduct.findUnique({
    where: { id: mappingId },
    include: { program: { select: { name: true } }, product: { select: { title: true, integrationId: true } }, variant: { select: { title: true } } },
  });
  if (!mapping) return { ok: false, error: "Mapping not found." };
  await db.subscriptionProgramProduct.delete({ where: { id: mappingId } });
  await logActivity(ctx, {
    actorType: "USER",
    actorId: ctx.userId,
    eventType: "PROGRAM_PRODUCT_UNMAPPED",
    entityType: "PROGRAM",
    entityId: mapping.programId,
    summary: `Removed "${mapping.product.title}${mapping.variant ? ` · ${mapping.variant.title}` : " (all variants)"}" from program "${mapping.program.name}"`,
  });
  await enqueueRecalc(ctx.organizationId, mapping.product.integrationId, "mapping_removed");
  revalidatePath("/products");
  revalidatePath("/subscriptions");
  return { ok: true };
}

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import { ForbiddenError, requireRole } from "@/lib/auth/tenancy";
import { logActivity } from "@/lib/domain/activity/log";
import { getRechargeConnectorForIntegration } from "@/lib/domain/integrations/connector";
import { parseExternalId } from "@/lib/integrations/recharge/ids";
import type { ActionResult } from "@/lib/domain/organizations/actions";

/**
 * Fulfilment markers — configuration only. Zero provider writes.
 *
 * Identity: the external VARIANT id, scoped to one integration. SKU/title are
 * operator-verification fields. A marker always references an internal
 * Product(type=FULFILMENT_MARKER)/ProductVariant pair belonging to that integration,
 * created here if the variant is not already in the catalogue.
 */

const markerSchema = z.object({
  id: z.string().min(1).optional(),
  integrationId: z.string().min(1),
  name: z.string().trim().min(2, "Give the marker an internal name.").max(80),
  description: z.string().trim().max(300).optional().or(z.literal("")),
  externalVariantId: z.string().trim().min(1, "The external (Shopify) variant id is required — it is what gets inserted into the shipment."),
  externalProductId: z.string().trim().optional().or(z.literal("")),
  title: z.string().trim().min(1, "Enter the item title as fulfilment will see it, e.g. “Morning Magic 2”.").max(120),
  sku: z.string().trim().max(64).optional().or(z.literal("")),
  source: z.enum(["MANUAL", "CATALOGUE", "DISCOVERED_ONETIME"]).default("MANUAL"),
  /** configuration-only stand-in; never executable (READY rules and the planner refuse it) */
  placeholder: z.boolean().optional().default(false),
});

async function admin() {
  try {
    return await requireRole("ADMIN");
  } catch (e) {
    if (e instanceof ForbiddenError) return null;
    throw e;
  }
}

export async function saveMarker(input: unknown): Promise<ActionResult<{ id: string }>> {
  const ctx = await admin();
  if (!ctx) return { ok: false, error: "You need the Admin or Owner role to manage markers." };
  const parsed = markerSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Please check the form.", fieldErrors: z.flattenError(parsed.error).fieldErrors };
  const d = parsed.data;
  const variantIdParsed = parseExternalId(d.externalVariantId);
  if (!variantIdParsed.ok || !variantIdParsed.id) return { ok: false, error: "The external variant id is not a valid id.", fieldErrors: { externalVariantId: ["Enter the numeric Shopify variant id (e.g. 49382910591234), not a GID or URL."] } };
  const externalVariantId = variantIdParsed.id;
  const productIdParsed = d.externalProductId ? parseExternalId(d.externalProductId) : { ok: true as const, id: null };
  if (!productIdParsed.ok) return { ok: false, error: "The external product id is not a valid id.", fieldErrors: { externalProductId: ["Enter the numeric Shopify product id, or leave blank."] } };
  const externalProductId = productIdParsed.id ?? `variant:${externalVariantId}`; // synthetic product identity when unknown

  const db = dbFor(ctx);
  const integration = await db.integration.findUnique({ where: { id: d.integrationId }, select: { id: true, displayName: true, status: true } });
  if (!integration) return { ok: false, error: "Integration not found in this organisation." };

  try {
    const result = await db.$transaction(async (tx) => {
      // internal catalogue rows for the marker item, scoped to the integration
      const product = await tx.product.upsert({
        where: { integrationId_externalProductId: { integrationId: integration.id, externalProductId } },
        create: { organizationId: ctx.organizationId, integrationId: integration.id, externalProductId, title: d.title, type: "FULFILMENT_MARKER", active: true, providerData: { source: d.source, syntheticProductId: !productIdParsed.id } },
        update: { type: "FULFILMENT_MARKER" },
        select: { id: true, integrationId: true },
      });
      const variant = await tx.productVariant.upsert({
        where: { productId_externalVariantId: { productId: product.id, externalVariantId } },
        create: { organizationId: ctx.organizationId, productId: product.id, externalVariantId, title: d.title, sku: d.sku || null, price: "0.00", active: true },
        update: { ...(d.sku ? { sku: d.sku } : {}) },
        select: { id: true, productId: true },
      });
      // defence in depth: variant must belong to the same integration
      const owner = await tx.product.findUniqueOrThrow({ where: { id: variant.productId }, select: { integrationId: true } });
      if (owner.integrationId !== integration.id) throw new Error("MARKER_INTEGRATION_MISMATCH");

      if (d.id) {
        const existing = await tx.fulfillmentMarker.findUnique({ where: { id: d.id }, select: { id: true, integrationId: true, name: true, externalVariantId: true, externalProductId: true, title: true, sku: true, placeholder: true, variantId: true, _count: { select: { actions: { where: { status: { in: ["EXECUTING", "ATTACHED"] } } } } } } });
        if (!existing) throw new Error("MARKER_NOT_FOUND");
        if (existing.integrationId !== integration.id) throw new Error("MARKER_INTEGRATION_MISMATCH");
        const identityChanged = existing.externalVariantId !== externalVariantId;
        if (identityChanged && existing._count.actions > 0) throw new Error("MARKER_HAS_ATTACHED_ACTIONS");
        const m = await tx.fulfillmentMarker.update({
          where: { id: d.id },
          data: { name: d.name, description: d.description || null, variantId: variant.id, externalVariantId, externalProductId: productIdParsed.id, title: d.title, sku: d.sku || null, source: d.source, placeholder: d.placeholder },
          select: { id: true, name: true },
        });
        // an identity change orphans the old internal marker catalogue rows — remove them when nothing references them
        if (identityChanged && existing.variantId !== variant.id) {
          const oldVariant = await tx.productVariant.findUnique({ where: { id: existing.variantId }, select: { id: true, productId: true, product: { select: { type: true } }, _count: { select: { subscriptions: true, journeys: true } } } });
          if (oldVariant && oldVariant.product.type === "FULFILMENT_MARKER" && oldVariant._count.subscriptions === 0 && oldVariant._count.journeys === 0) {
            await tx.productVariant.delete({ where: { id: oldVariant.id } });
            const siblings = await tx.productVariant.count({ where: { productId: oldVariant.productId } });
            if (siblings === 0) await tx.product.delete({ where: { id: oldVariant.productId } });
          }
        }
        return { ...m, created: false, previous: { name: existing.name, externalVariantId: existing.externalVariantId, externalProductId: existing.externalProductId, title: existing.title, sku: existing.sku, placeholder: existing.placeholder }, identityChanged };
      }
      const m = await tx.fulfillmentMarker.create({
        data: { organizationId: ctx.organizationId, integrationId: integration.id, name: d.name, description: d.description || null, variantId: variant.id, externalVariantId, externalProductId: productIdParsed.id, title: d.title, sku: d.sku || null, source: d.source, placeholder: d.placeholder },
        select: { id: true, name: true },
      });
      return { ...m, created: true, previous: null, identityChanged: false };
    });
    await logActivity(ctx, {
      actorType: "USER",
      actorId: ctx.userId,
      eventType: result.created ? "MARKER_CREATED" : result.identityChanged ? "MARKER_IDENTITY_CHANGED" : "MARKER_UPDATED",
      entityType: "FULFILLMENT_MARKER",
      entityId: result.id,
      summary: `${result.created ? "Created" : result.identityChanged ? "Re-pointed" : "Updated"} fulfilment marker "${result.name}" → ${d.title}${d.sku ? ` (${d.sku})` : ""} · variant ${externalVariantId} on ${integration.displayName}${d.placeholder ? " · PLACEHOLDER (not executable)" : ""}${result.identityChanged && result.previous ? ` · previously variant ${result.previous.externalVariantId} "${result.previous.title ?? ""}"` : ""}`,
      metadata: { externalVariantId, externalProductId: productIdParsed.id, source: d.source, placeholder: d.placeholder, previous: result.previous ?? undefined, identityChanged: result.identityChanged },
    });
    revalidatePath("/products");
    revalidatePath("/rules");
    return { ok: true, data: { id: result.id } };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const target = String((e.meta as { target?: unknown })?.target ?? "");
      if (target.includes("name")) return { ok: false, error: "A marker with that name already exists." };
      return { ok: false, error: "That external variant is already configured as a marker for this integration." };
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "MARKER_INTEGRATION_MISMATCH") return { ok: false, error: "That variant belongs to a different integration." };
    if (msg === "MARKER_NOT_FOUND") return { ok: false, error: "Marker not found." };
    if (msg === "MARKER_HAS_ATTACHED_ACTIONS") return { ok: false, error: "This marker has actions that are attaching or attached in the subscription platform; its external identity cannot change until they complete. Create a new marker instead." };
    throw e;
  }
}

export async function setMarkerActive(input: unknown): Promise<ActionResult> {
  const ctx = await admin();
  if (!ctx) return { ok: false, error: "You need the Admin or Owner role to manage markers." };
  const parsed = z.object({ id: z.string().min(1), active: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const db = dbFor(ctx);
  const marker = await db.fulfillmentMarker.findUnique({ where: { id: parsed.data.id }, include: { rules: { where: { status: { in: ["READY", "ACTIVE"] } }, select: { id: true, name: true } } } });
  if (!marker) return { ok: false, error: "Marker not found." };
  if (!parsed.data.active && marker.rules.length) {
    return { ok: false, error: `This marker is used by ${marker.rules.length} ready/active rule${marker.rules.length === 1 ? "" : "s"} (${marker.rules.map((r) => r.name).join(", ")}). Disable or archive those first.` };
  }
  await db.fulfillmentMarker.update({ where: { id: marker.id }, data: { active: parsed.data.active } });
  await logActivity(ctx, { actorType: "USER", actorId: ctx.userId, eventType: parsed.data.active ? "MARKER_ACTIVATED" : "MARKER_DEACTIVATED", entityType: "FULFILLMENT_MARKER", entityId: marker.id, summary: `${parsed.data.active ? "Activated" : "Deactivated"} fulfilment marker "${marker.name}"` });
  revalidatePath("/products");
  return { ok: true };
}

export type DiscoveredMarker = {
  externalVariantId: string;
  externalProductId: string | null;
  title: string | null;
  sku: string | null;
  price: string | null;
  occurrences: number;
  lastSeen: string | null; // YYYY-MM-DD of the latest scheduled date
  alreadyConfigured: boolean;
};

/**
 * READ-ONLY discovery: list existing one-times in the store and summarise distinct
 * variants, so the operator can pre-fill a marker from the manually-created £0
 * test item. Nothing is saved here and nothing is written to the provider.
 */
export async function discoverMarkersFromOnetimes(integrationId: string): Promise<ActionResult<DiscoveredMarker[]>> {
  const ctx = await admin();
  if (!ctx) return { ok: false, error: "You need the Admin or Owner role to manage markers." };
  try {
    const { connector } = await getRechargeConnectorForIntegration(ctx, integrationId, { correlationId: "marker-discovery" });
    const seen = new Map<string, DiscoveredMarker>();
    let pages = 0;
    for await (const page of connector.listOnetimes({ limit: 250 })) {
      for (const t of page.items) {
        if (!t.externalVariantId) continue;
        const cur = seen.get(t.externalVariantId);
        if (cur) {
          cur.occurrences++;
          if (t.nextChargeDate && (!cur.lastSeen || t.nextChargeDate > cur.lastSeen)) cur.lastSeen = t.nextChargeDate;
          cur.title ??= t.productTitle;
          cur.sku ??= t.sku;
        } else {
          seen.set(t.externalVariantId, { externalVariantId: t.externalVariantId, externalProductId: t.externalProductId, title: t.productTitle, sku: t.sku, price: t.price, occurrences: 1, lastSeen: t.nextChargeDate, alreadyConfigured: false });
        }
      }
      if (++pages >= 20) break; // discovery is a convenience; cap the read
    }
    const existing = await dbFor(ctx).fulfillmentMarker.findMany({ where: { integrationId }, select: { externalVariantId: true } });
    const configured = new Set(existing.map((m) => m.externalVariantId));
    const out = [...seen.values()].map((m) => ({ ...m, alreadyConfigured: configured.has(m.externalVariantId) }));
    return { ok: true, data: out };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not read one-times from the provider." };
  }
}

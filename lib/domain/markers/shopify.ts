/**
 * Fulfilment markers ↔ Shopify (Phase 4c): discover, create, adopt and verify the Shopify products/
 * variants our FulfillmentMarkers point at. The canonical execution identity stays the numeric
 * Shopify VARIANT id stored on the marker (scoped to the Recharge integration that will reference
 * it); everything Shopify-specific here is catalogue identity + verification.
 *
 * Never touches Recharge. Never creates actions. Shopify writes are limited to the marker product
 * (create / update / publish) and happen only through the explicit create/adopt flows below.
 */
import { Prisma } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import { logActivity } from "@/lib/domain/activity/log";
import { bindProgramMarker } from "@/lib/domain/rewards/core";
import { MARKER_PRODUCT_TYPE, MARKER_TAG, type MarkerProductSpec, type ShopifyConnector, type ShopifyProductSummary } from "@/lib/integrations/shopify";
import { findShopifyIntegrationForRecharge, getShopifyConnectorForIntegration } from "@/lib/domain/integrations/shopify";
import { parseExternalId } from "@/lib/integrations/recharge/ids";

type Ctx = { organizationId: string; userId?: string | null };
type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string; code?: string; candidates?: ExistingCandidate[] };

// ── naming ─────────────────────────────────────────────────────────────────

/** Default warehouse label / SKU prefix from a programme name. Operators can override per programme. */
export function deriveMarkerNaming(programName: string): { markerLabel: string; skuPrefix: string } {
  const label = programName.trim();
  const prefix = label
    .toUpperCase()
    .replace(/['’]/g, "")
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return { markerLabel: label, skuPrefix: prefix || "MARKER" };
}

export function markerTitleFor(markerLabel: string, cycleNumber: number): string {
  return `${markerLabel.trim()} ${cycleNumber}`;
}
export function markerSkuFor(skuPrefix: string, cycleNumber: number): string {
  return `${skuPrefix.trim().toUpperCase()}-CYCLE-${String(cycleNumber).padStart(2, "0")}`;
}

export function markerSpecFor(input: { title: string; sku: string; rewardItemName: string; programName: string; cycleNumber: number; operationalNote?: string | null }): MarkerProductSpec {
  return {
    title: input.title,
    sku: input.sku,
    price: "0.00",
    status: "UNLISTED", // target state: usable by Recharge/apps, hidden from storefront discovery; never DRAFT merely to hide
    productType: MARKER_PRODUCT_TYPE,
    tags: [MARKER_TAG, `reward:${input.rewardItemName.toLowerCase().replace(/\s+/g, "-")}`],
    descriptionHtml: `<p>Operational fulfilment marker — not for sale. ${input.programName} delivery ${input.cycleNumber}: ${input.operationalNote ?? `include ${input.rewardItemName.toLowerCase()}`}.</p>`,
    publishToOnlineStore: true,
  };
}

// ── missing markers ────────────────────────────────────────────────────────

export type MissingMarkerRow = {
  programId: string;
  programName: string;
  markerLabel: string;
  skuPrefix: string;
  scheduleId: string;
  scheduleName: string;
  milestoneId: string;
  cycleNumber: number;
  rewardItemId: string;
  rewardItemName: string;
  rewardOperational: string | null;
  proposedTitle: string;
  proposedSku: string;
  /** binding exists but points at a placeholder marker that must be replaced */
  placeholderMarkerId: string | null;
  placeholderMarkerName: string | null;
  rechargeIntegrationId: string | null;
  shopifyIntegrationId: string | null;
};

export async function listMissingMarkers(ctx: { organizationId: string }): Promise<MissingMarkerRow[]> {
  const db = dbFor(ctx);
  const programs = await db.subscriptionProgram.findMany({
    where: { rewardScheduleId: { not: null }, active: true },
    include: { rewardSchedule: { include: { milestones: { where: { active: true, executionMode: "UPCOMING_RENEWAL" }, include: { rewardItem: true }, orderBy: { cycleNumber: "asc" } } } }, milestoneMarkers: { include: { fulfillmentMarker: { select: { id: true, name: true, placeholder: true } } } }, products: { select: { product: { select: { integrationId: true } } }, take: 1 } },
    orderBy: { name: "asc" },
  });
  const rows: MissingMarkerRow[] = [];
  const shopifyFor = new Map<string, string | null>();
  for (const p of programs) {
    if (!p.rewardSchedule || p.rewardSchedule.status === "ARCHIVED") continue;
    const naming = { markerLabel: p.markerLabel ?? deriveMarkerNaming(p.name).markerLabel, skuPrefix: p.skuPrefix ?? deriveMarkerNaming(p.name).skuPrefix };
    const rechargeIntegrationId = p.products[0]?.product.integrationId ?? null;
    if (rechargeIntegrationId && !shopifyFor.has(rechargeIntegrationId)) shopifyFor.set(rechargeIntegrationId, (await findShopifyIntegrationForRecharge(ctx, rechargeIntegrationId))?.id ?? null);
    for (const m of p.rewardSchedule.milestones) {
      const binding = p.milestoneMarkers.find((b) => b.rewardScheduleMilestoneId === m.id && b.active);
      if (binding && !binding.fulfillmentMarker.placeholder) continue; // real marker bound → not missing
      rows.push({
        programId: p.id,
        programName: p.name,
        markerLabel: naming.markerLabel,
        skuPrefix: naming.skuPrefix,
        scheduleId: p.rewardSchedule.id,
        scheduleName: p.rewardSchedule.name,
        milestoneId: m.id,
        cycleNumber: m.cycleNumber,
        rewardItemId: m.rewardItem.id,
        rewardItemName: m.rewardItem.name,
        rewardOperational: m.rewardItem.operationalDescription,
        proposedTitle: markerTitleFor(naming.markerLabel, m.cycleNumber),
        proposedSku: markerSkuFor(naming.skuPrefix, m.cycleNumber),
        placeholderMarkerId: binding?.fulfillmentMarker.id ?? null,
        placeholderMarkerName: binding?.fulfillmentMarker.name ?? null,
        rechargeIntegrationId,
        shopifyIntegrationId: rechargeIntegrationId ? (shopifyFor.get(rechargeIntegrationId) ?? null) : null,
      });
    }
  }
  return rows;
}

export async function setProgramMarkerNaming(ctx: Ctx, input: { programId: string; markerLabel: string; skuPrefix: string }): Promise<Result> {
  const db = dbFor(ctx);
  const p = await db.subscriptionProgram.findUnique({ where: { id: input.programId }, select: { id: true, name: true, markerLabel: true, skuPrefix: true } });
  if (!p) return { ok: false, error: "Programme not found." };
  const markerLabel = input.markerLabel.trim();
  const skuPrefix = input.skuPrefix.trim().toUpperCase();
  if (markerLabel.length < 2 || !/^[A-Z0-9][A-Z0-9-]*$/.test(skuPrefix)) return { ok: false, error: "Marker label (2+ chars) and SKU prefix (A–Z, 0–9, dashes) are required." };
  await db.subscriptionProgram.update({ where: { id: p.id }, data: { markerLabel, skuPrefix } });
  await logActivity(ctx, { actorType: ctx.userId ? "USER" : "SYSTEM", actorId: ctx.userId ?? null, eventType: "PROGRAM_MARKER_NAMING_SET", entityType: "PROGRAM", entityId: p.id, summary: `Programme "${p.name}" marker naming: label "${markerLabel}", SKU prefix ${skuPrefix}${p.markerLabel ? ` (was "${p.markerLabel}" / ${p.skuPrefix})` : ""}` });
  return { ok: true };
}

// ── duplicate detection ────────────────────────────────────────────────────

export type ExistingCandidate = { matchedBy: "VARIANT_ID" | "SKU" | "TITLE" | "INTERNAL_MARKER"; product: ShopifyProductSummary | null; internalMarker: { id: string; name: string; externalVariantId: string; placeholder: boolean } | null };

export async function findExistingMarkerCandidates(ctx: { organizationId: string }, connector: Pick<ShopifyConnector, "getProductByVariantId" | "searchBySku" | "searchByTitle">, input: { sku: string; title: string; variantId?: string | null; shopifyIntegrationId: string; rechargeIntegrationId: string | null }): Promise<ExistingCandidate[]> {
  const db = dbFor(ctx);
  const out: ExistingCandidate[] = [];
  const seen = new Set<string>();
  const push = (matchedBy: ExistingCandidate["matchedBy"], product: ShopifyProductSummary | null, internal: ExistingCandidate["internalMarker"] = null) => {
    const key = `${matchedBy}:${product?.productId ?? internal?.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ matchedBy, product, internalMarker: internal });
  };
  if (input.variantId) {
    const p = await connector.getProductByVariantId(input.variantId);
    if (p) push("VARIANT_ID", p);
  }
  for (const p of await connector.searchBySku(input.sku)) if (p.variants.some((v) => v.sku?.toUpperCase() === input.sku.toUpperCase())) push("SKU", p);
  for (const p of await connector.searchByTitle(input.title)) if (p.title.trim().toLowerCase() === input.title.trim().toLowerCase()) push("TITLE", p);
  // internal: another marker in this organisation already claims the SKU/title/variant
  const internal = await db.fulfillmentMarker.findMany({
    where: { OR: [{ sku: { equals: input.sku, mode: "insensitive" } }, { title: { equals: input.title, mode: "insensitive" } }, { name: { equals: input.title, mode: "insensitive" } }, ...(input.variantId ? [{ externalVariantId: input.variantId }] : [])], ...(input.rechargeIntegrationId ? { integrationId: input.rechargeIntegrationId } : {}) },
    select: { id: true, name: true, externalVariantId: true, placeholder: true },
  });
  for (const m of internal) push("INTERNAL_MARKER", null, m);
  return out;
}

// ── create / adopt ─────────────────────────────────────────────────────────

async function resolveTargets(ctx: Ctx, programId: string, milestoneId: string) {
  const db = dbFor(ctx);
  const program = await db.subscriptionProgram.findUnique({ where: { id: programId }, select: { id: true, name: true, markerLabel: true, skuPrefix: true, rewardScheduleId: true, products: { select: { product: { select: { integrationId: true } } } } } });
  if (!program) throw new Error("Programme not found.");
  const milestone = await db.rewardScheduleMilestone.findUnique({ where: { id: milestoneId }, include: { rewardItem: true, schedule: { select: { id: true, name: true } } } });
  if (!milestone) throw new Error("Milestone not found.");
  if (milestone.scheduleId !== program.rewardScheduleId) throw new Error(`"${program.name}" is not on the schedule "${milestone.schedule.name}".`);
  if (milestone.executionMode !== "UPCOMING_RENEWAL") throw new Error("Initial-checkout milestones have no renewal marker.");
  const integrations = [...new Set(program.products.map((p) => p.product.integrationId))];
  if (integrations.length !== 1) throw new Error(integrations.length === 0 ? "The programme has no mapped products, so its store is unknown." : "The programme spans several stores; markers must be created per store.");
  const rechargeIntegrationId = integrations[0];
  const shopify = await findShopifyIntegrationForRecharge(ctx, rechargeIntegrationId);
  if (!shopify) throw new Error("No Shopify store is connected/paired with this programme's Recharge store. Connect Shopify under Settings → Integrations first.");
  return { program, milestone, rechargeIntegrationId, shopifyIntegrationId: shopify.id };
}

async function upsertMarkerFromShopify(ctx: Ctx, input: { product: ShopifyProductSummary; variantId: string; rechargeIntegrationId: string; shopifyIntegrationId: string; name: string; rewardItemId: string; operationalNote: string | null; replaceMarkerId: string | null; source: "CATALOGUE" | "DISCOVERED_ONETIME" | "MANUAL" }) {
  const db = dbFor(ctx);
  const v = input.product.variants.find((x) => x.variantId === input.variantId);
  if (!v) throw new Error("Variant not found on the Shopify product.");
  const verification = { checkedAt: new Date().toISOString(), product: input.product, issues: markerIssues(input.product, v, { expectedSku: v.sku, expectedTitle: input.product.title }) };
  const fields = {
    name: input.name,
    title: input.product.title,
    sku: v.sku,
    externalProductId: input.product.productId,
    externalVariantId: v.variantId,
    placeholder: false,
    active: true,
    source: input.source,
    rewardItemId: input.rewardItemId,
    operationalNote: input.operationalNote,
    shopifyIntegrationId: input.shopifyIntegrationId,
    shopifyStatus: input.product.status,
    shopifyPublishedOnlineStore: input.product.publishedOnlineStore,
    shopifyPrice: v.price,
    shopifyInventoryTracked: v.inventoryTracked,
    shopifyHandle: input.product.handle,
    lastVerifiedAt: new Date(),
    verificationJson: verification as unknown as Prisma.InputJsonValue,
  };
  return db.$transaction(async (tx) => {
    // internal catalogue rows for the marker item, scoped to the Recharge integration (same shape saveMarker uses)
    const catalogueProduct = await tx.product.upsert({
      where: { integrationId_externalProductId: { integrationId: input.rechargeIntegrationId, externalProductId: input.product.productId } },
      create: { organizationId: ctx.organizationId, integrationId: input.rechargeIntegrationId, externalProductId: input.product.productId, title: input.product.title, type: "FULFILMENT_MARKER", active: true, providerData: { source: "SHOPIFY_MARKER" } },
      update: { type: "FULFILMENT_MARKER", title: input.product.title },
      select: { id: true },
    });
    const catalogueVariant = await tx.productVariant.upsert({
      where: { productId_externalVariantId: { productId: catalogueProduct.id, externalVariantId: v.variantId } },
      create: { organizationId: ctx.organizationId, productId: catalogueProduct.id, externalVariantId: v.variantId, title: input.product.title, sku: v.sku, price: "0.00", active: true },
      update: { title: input.product.title, ...(v.sku ? { sku: v.sku } : {}) },
      select: { id: true },
    });
    const variantRowId = catalogueVariant.id;
    if (input.replaceMarkerId) {
      const prev = await tx.fulfillmentMarker.findUnique({ where: { id: input.replaceMarkerId }, select: { id: true, integrationId: true, variantId: true, externalVariantId: true, name: true, title: true, placeholder: true, _count: { select: { actions: { where: { status: { in: ["EXECUTING", "ATTACHED"] } } } } } } });
      if (!prev) throw new Error("Marker to replace not found.");
      if (prev.integrationId !== input.rechargeIntegrationId) throw new Error("Marker to replace belongs to a different store.");
      if (prev._count.actions > 0) throw new Error("Marker has attaching/attached actions; it cannot be re-pointed now.");
      const m = await tx.fulfillmentMarker.update({ where: { id: prev.id }, data: { ...fields, variantId: variantRowId } });
      // remove the orphaned placeholder catalogue rows (only FULFILMENT_MARKER rows nothing references)
      if (prev.variantId !== variantRowId) {
        const old = await tx.productVariant.findUnique({ where: { id: prev.variantId }, select: { id: true, productId: true, product: { select: { type: true } }, _count: { select: { subscriptions: true, journeys: true, markers: true } } } });
        if (old && old.product.type === "FULFILMENT_MARKER" && old._count.subscriptions === 0 && old._count.journeys === 0 && old._count.markers === 0) {
          await tx.productVariant.delete({ where: { id: old.id } });
          if ((await tx.productVariant.count({ where: { productId: old.productId } })) === 0) await tx.product.delete({ where: { id: old.productId } });
        }
      }
      return { marker: m, previous: { name: prev.name, title: prev.title, externalVariantId: prev.externalVariantId, placeholder: prev.placeholder } };
    }
    const m = await tx.fulfillmentMarker.create({ data: { organizationId: ctx.organizationId, integrationId: input.rechargeIntegrationId, variantId: variantRowId, ...fields } });
    return { marker: m, previous: null };
  });
}

export type MarkerCreateInput = { programId: string; milestoneId: string; title: string; sku: string; operationalNote?: string | null; replaceMarkerId?: string | null; acknowledgeCandidates?: boolean };

/**
 * Create the marker product in Shopify (explicit, confirmed action) and bind it to the programme
 * milestone. Refuses with POSSIBLE_EXISTING_MARKER when something that looks like the marker already
 * exists, unless the operator acknowledged the candidates.
 */
export async function createMarkerInShopify(ctx: Ctx, input: MarkerCreateInput): Promise<Result<{ markerId: string; productId: string; variantId: string; product: ShopifyProductSummary }>> {
  let targets;
  try {
    targets = await resolveTargets(ctx, input.programId, input.milestoneId);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const { program, milestone, rechargeIntegrationId, shopifyIntegrationId } = targets;
  const title = input.title.trim();
  const sku = input.sku.trim().toUpperCase();
  if (title.length < 2 || sku.length < 3) return { ok: false, error: "Title and SKU are required." };
  const { connector } = await getShopifyConnectorForIntegration(ctx, shopifyIntegrationId, { correlationId: `mk_create_${milestone.id.slice(-6)}` });
  const candidates = await findExistingMarkerCandidates(ctx, connector, { sku, title, shopifyIntegrationId, rechargeIntegrationId });
  const blocking = candidates.filter((c) => !(c.matchedBy === "INTERNAL_MARKER" && c.internalMarker?.id === input.replaceMarkerId));
  if (blocking.length > 0 && !input.acknowledgeCandidates) {
    return { ok: false, code: "POSSIBLE_EXISTING_MARKER", error: `Something that looks like this marker already exists (${blocking.map((c) => c.matchedBy).join(", ")}). Inspect the candidates and adopt the existing product, or acknowledge and create anyway.`, candidates: blocking };
  }
  const operationalNote = input.operationalNote?.trim() || (milestone.rewardItem.operationalDescription ?? `Include ${milestone.rewardItem.name.toLowerCase()}`);
  const spec = markerSpecFor({ title, sku, rewardItemName: milestone.rewardItem.name, programName: program.name, cycleNumber: milestone.cycleNumber, operationalNote });
  const product = await connector.createMarkerProduct(spec);
  const variant = product.variants[0];
  if (!variant) return { ok: false, error: "Shopify created the product without a variant." };
  const { marker, previous } = await upsertMarkerFromShopify(ctx, { product, variantId: variant.variantId, rechargeIntegrationId, shopifyIntegrationId, name: title, rewardItemId: milestone.rewardItemId, operationalNote, replaceMarkerId: input.replaceMarkerId ?? null, source: "CATALOGUE" });
  await logActivity(ctx, {
    actorType: ctx.userId ? "USER" : "SYSTEM",
    actorId: ctx.userId ?? null,
    eventType: previous ? "MARKER_CREATED_IN_SHOPIFY_REPLACING_PLACEHOLDER" : "MARKER_CREATED_IN_SHOPIFY",
    entityType: "FULFILLMENT_MARKER",
    entityId: marker.id,
    summary: `Created Shopify product "${product.title}" (product ${product.productId}, variant ${variant.variantId}, SKU ${variant.sku ?? "—"}, ${product.status}, Online Store ${product.publishedOnlineStore ? "published" : "not published"}, £${variant.price}) → marker "${marker.name}" = ${milestone.rewardItem.name} for ${program.name} delivery ${milestone.cycleNumber}${previous ? ` · replaced ${previous.placeholder ? "placeholder " : ""}"${previous.name}" (variant ${previous.externalVariantId})` : ""}. Recharge compatibility: UNVERIFIED.`,
    metadata: { productId: product.productId, variantId: variant.variantId, sku: variant.sku, status: product.status, publishedOnlineStore: product.publishedOnlineStore, previous, candidatesAcknowledged: blocking.length },
  });
  const bound = await bindProgramMarker(ctx, { programId: program.id, milestoneId: milestone.id, fulfillmentMarkerId: marker.id });
  if (!bound.ok) return { ok: false, error: `Marker created (${marker.id}) but binding failed: ${bound.error}` };
  return { ok: true, data: { markerId: marker.id, productId: product.productId, variantId: variant.variantId, product } };
}

/** Adopt an existing Shopify variant as the marker (after inspection). Read-only on Shopify. */
export async function adoptShopifyVariant(ctx: Ctx, input: { programId: string; milestoneId: string; variantId: string; name?: string | null; operationalNote?: string | null; replaceMarkerId?: string | null }): Promise<Result<{ markerId: string; product: ShopifyProductSummary }>> {
  let targets;
  try {
    targets = await resolveTargets(ctx, input.programId, input.milestoneId);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const parsed = parseExternalId(input.variantId);
  if (!parsed.ok || !parsed.id || !/^[0-9]+$/.test(parsed.id)) return { ok: false, error: "Enter the numeric Shopify variant id." };
  const { program, milestone, rechargeIntegrationId, shopifyIntegrationId } = targets;
  const { connector } = await getShopifyConnectorForIntegration(ctx, shopifyIntegrationId, { correlationId: `mk_adopt_${milestone.id.slice(-6)}` });
  const product = await connector.getProductByVariantId(parsed.id);
  if (!product) return { ok: false, error: `No Shopify variant ${parsed.id} in ${connector.shopDomain}.` };
  const name = input.name?.trim() || product.title;
  const operationalNote = input.operationalNote?.trim() || (milestone.rewardItem.operationalDescription ?? `Include ${milestone.rewardItem.name.toLowerCase()}`);
  let result;
  try {
    result = await upsertMarkerFromShopify(ctx, { product, variantId: parsed.id, rechargeIntegrationId, shopifyIntegrationId, name, rewardItemId: milestone.rewardItemId, operationalNote, replaceMarkerId: input.replaceMarkerId ?? null, source: "CATALOGUE" });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, error: "That Shopify variant (or marker name) is already claimed by another marker in this store." };
    throw e;
  }
  await logActivity(ctx, { actorType: ctx.userId ? "USER" : "SYSTEM", actorId: ctx.userId ?? null, eventType: "MARKER_ADOPTED_FROM_SHOPIFY", entityType: "FULFILLMENT_MARKER", entityId: result.marker.id, summary: `Adopted Shopify variant ${parsed.id} ("${product.title}", SKU ${product.variants.find((v) => v.variantId === parsed.id)?.sku ?? "—"}, ${product.status}) as marker "${name}" = ${milestone.rewardItem.name} for ${program.name} delivery ${milestone.cycleNumber}${result.previous ? ` · replaced "${result.previous.name}"` : ""}.`, metadata: { productId: product.productId, variantId: parsed.id, previous: result.previous } });
  const bound = await bindProgramMarker(ctx, { programId: program.id, milestoneId: milestone.id, fulfillmentMarkerId: result.marker.id });
  if (!bound.ok) return { ok: false, error: `Marker adopted (${result.marker.id}) but binding failed: ${bound.error}` };
  return { ok: true, data: { markerId: result.marker.id, product } };
}

// ── verification ───────────────────────────────────────────────────────────

export type MarkerIssue = "MISSING_IN_SHOPIFY" | "VISIBLE_TO_CUSTOMERS" | "DRAFT_OR_ARCHIVED" | "NOT_PUBLISHED_ONLINE_STORE" | "PRICE_NOT_ZERO" | "SKU_MISMATCH" | "TITLE_MISMATCH" | "INVENTORY_TRACKED" | "MISSING_MARKER_TAG";

export const MARKER_ISSUE_LABEL: Record<MarkerIssue, string> = {
  MISSING_IN_SHOPIFY: "Variant no longer exists in Shopify",
  VISIBLE_TO_CUSTOMERS: "Product is ACTIVE (discoverable) — expected UNLISTED",
  DRAFT_OR_ARCHIVED: "Product is DRAFT/ARCHIVED — unavailable to apps and Recharge",
  NOT_PUBLISHED_ONLINE_STORE: "Not published to the Online Store sales channel",
  PRICE_NOT_ZERO: "Variant price is not 0.00",
  SKU_MISMATCH: "Shopify SKU differs from the marker SKU",
  TITLE_MISMATCH: "Shopify title differs from the marker title",
  INVENTORY_TRACKED: "Inventory is tracked (stock could block the one-time)",
  MISSING_MARKER_TAG: "Missing the subscription-ops-marker tag / Fulfillment Marker type",
};

export function markerIssues(product: ShopifyProductSummary | null, variant: { sku: string | null; price: string; inventoryTracked: boolean | null } | null, expected: { expectedSku: string | null; expectedTitle: string | null }): MarkerIssue[] {
  if (!product || !variant) return ["MISSING_IN_SHOPIFY"];
  const issues: MarkerIssue[] = [];
  if (product.status === "ACTIVE") issues.push("VISIBLE_TO_CUSTOMERS");
  if (product.status === "DRAFT" || product.status === "ARCHIVED") issues.push("DRAFT_OR_ARCHIVED");
  if (product.publishedOnlineStore === false) issues.push("NOT_PUBLISHED_ONLINE_STORE");
  if (Number(variant.price) !== 0) issues.push("PRICE_NOT_ZERO");
  if (expected.expectedSku && (variant.sku ?? "").toUpperCase() !== expected.expectedSku.toUpperCase()) issues.push("SKU_MISMATCH");
  if (expected.expectedTitle && product.title.trim().toLowerCase() !== expected.expectedTitle.trim().toLowerCase()) issues.push("TITLE_MISMATCH");
  if (variant.inventoryTracked === true) issues.push("INVENTORY_TRACKED");
  if (!product.tags.includes(MARKER_TAG) && product.productType !== MARKER_PRODUCT_TYPE) issues.push("MISSING_MARKER_TAG");
  return issues;
}

export async function verifyMarkerInShopify(ctx: Ctx, markerId: string): Promise<Result<{ issues: MarkerIssue[]; product: ShopifyProductSummary | null }>> {
  const db = dbFor(ctx);
  const marker = await db.fulfillmentMarker.findUnique({ where: { id: markerId }, select: { id: true, name: true, title: true, sku: true, externalVariantId: true, integrationId: true, shopifyIntegrationId: true, placeholder: true } });
  if (!marker) return { ok: false, error: "Marker not found." };
  const shopifyIntegrationId = marker.shopifyIntegrationId ?? (await findShopifyIntegrationForRecharge(ctx, marker.integrationId))?.id ?? null;
  if (!shopifyIntegrationId) return { ok: false, error: "No Shopify store is connected for this marker's store." };
  const { connector } = await getShopifyConnectorForIntegration(ctx, shopifyIntegrationId, { correlationId: `mk_verify_${marker.id.slice(-6)}` });
  const product = await connector.getProductByVariantId(marker.externalVariantId);
  const variant = product?.variants.find((v) => v.variantId === marker.externalVariantId) ?? null;
  const issues = markerIssues(product, variant, { expectedSku: marker.sku, expectedTitle: marker.title ?? marker.name });
  await db.fulfillmentMarker.update({
    where: { id: marker.id },
    data: {
      shopifyIntegrationId,
      shopifyStatus: product?.status ?? null,
      shopifyPublishedOnlineStore: product?.publishedOnlineStore ?? null,
      shopifyPrice: variant?.price ?? null,
      shopifyInventoryTracked: variant?.inventoryTracked ?? null,
      shopifyHandle: product?.handle ?? null,
      lastVerifiedAt: new Date(),
      verificationJson: { checkedAt: new Date().toISOString(), product, issues } as unknown as Prisma.InputJsonValue,
    },
  });
  await logActivity(ctx, { actorType: ctx.userId ? "USER" : "SYSTEM", actorId: ctx.userId ?? null, eventType: "MARKER_VERIFIED_IN_SHOPIFY", entityType: "FULFILLMENT_MARKER", entityId: marker.id, summary: `Verified marker "${marker.name}" in Shopify: ${product ? `${product.status}, Online Store ${product.publishedOnlineStore ? "published" : "NOT published"}, price ${variant?.price ?? "?"}, SKU ${variant?.sku ?? "—"}` : "variant MISSING"}${issues.length ? ` · issues: ${issues.join(", ")}` : " · no issues"}${marker.placeholder ? " · (placeholder)" : ""}`, metadata: { issues, productId: product?.productId ?? null } });
  return { ok: true, data: { issues, product } };
}

import "server-only";
import type { Prisma } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import type { RechargeConnector } from "@/lib/integrations/recharge";
import { isRechargeError } from "@/lib/integrations/recharge/errors";
import type { ConnectorOrder, ConnectorProduct, ConnectorSubscription } from "@/lib/integrations/types";
import { recalculateJourneysForSubscriptions } from "@/lib/domain/journeys/recalc";
import type { SyncCounts } from "./progress";
import { localMidnightUtc } from "@/lib/domain/time";

/**
 * Import stages. Each function imports ONE page and returns the next cursor and
 * count deltas, so the orchestrating job can persist progress between pages and
 * resume after a crash. Everything is an upsert keyed by the provider's ids
 * scoped to the integration — running a page twice changes nothing.
 *
 * READ-ONLY with respect to the provider: nothing here calls a write endpoint.
 */
type Ctx = { organizationId: string };
type PageResult = { nextCursor: string | null; items: number; delta: Partial<SyncCounts> };

// ── products ───────────────────────────────────────────────────────────────

/** True when Recharge says /products is not available on this store's platform (Shopify checkout). */
export function isProductsEndpointUnavailable(e: unknown): boolean {
  return isRechargeError(e) && e.kind === "VALIDATION_ERROR" && /platform/i.test(e.message);
}

export async function importProductsPage(ctx: Ctx, connector: RechargeConnector, integrationId: string, cursor: string | null, updatedSince?: Date | null): Promise<PageResult> {
  const iter = connector.listProducts({ startCursor: cursor, updatedSince: updatedSince ?? undefined });
  let page: IteratorResult<Awaited<ReturnType<typeof iter.next>>["value"]>;
  try {
    page = await iter.next();
  } catch (e) {
    if (isProductsEndpointUnavailable(e)) {
      // Catalogue is derived from subscriptions + order lines instead (see below).
      return { nextCursor: null, items: 0, delta: { productsEndpointUnavailable: 1 } };
    }
    throw e;
  }
  if (page.done) return { nextCursor: null, items: 0, delta: {} };
  const { items, skipped, skippedVariants, nextCursor } = page.value;
  let variants = 0;
  for (const p of items) variants += await upsertProduct(ctx, integrationId, p);
  return { nextCursor, items: items.length, delta: { products: items.length, variants, productsSkipped: skipped, variantsSkipped: skippedVariants } };
}

async function upsertProduct(ctx: Ctx, integrationId: string, p: ConnectorProduct): Promise<number> {
  const db = dbFor(ctx);
  const product = await db.product.upsert({
    where: { integrationId_externalProductId: { integrationId, externalProductId: p.externalProductId } },
    create: {
      organizationId: ctx.organizationId,
      integrationId,
      externalProductId: p.externalProductId,
      title: p.title,
      active: p.active,
      providerData: (p.providerData ?? undefined) as Prisma.InputJsonValue | undefined,
      lastSyncedAt: new Date(),
    },
    update: { title: p.title, active: p.active, providerData: (p.providerData ?? undefined) as Prisma.InputJsonValue | undefined, lastSyncedAt: new Date() },
    select: { id: true },
  });
  for (const v of p.variants) {
    await db.productVariant.upsert({
      where: { productId_externalVariantId: { productId: product.id, externalVariantId: v.externalVariantId } },
      create: { organizationId: ctx.organizationId, productId: product.id, externalVariantId: v.externalVariantId, title: v.title, sku: v.sku, price: v.price, active: true },
      update: { title: v.title, sku: v.sku, price: v.price, active: true },
    });
  }
  return p.variants.length;
}

/**
 * Upsert Product/ProductVariant rows from identifiers seen on subscriptions or
 * order lines. Creates missing rows with the titles/SKU we observed; existing
 * rows keep their title (a /products import or an earlier, current subscription
 * is a better source than an old order line) but gain a missing SKU/variant title.
 */
export async function deriveCatalogue(
  ctx: Ctx,
  integrationId: string,
  seen: { externalProductId: string; externalVariantId: string; productTitle: string | null; variantTitle: string | null; sku: string | null; price: string | null }[],
): Promise<{ products: number; variants: number }> {
  const db = dbFor(ctx);
  const byProduct = new Map<string, { title: string | null; variants: Map<string, { title: string | null; sku: string | null; price: string | null }> }>();
  for (const s of seen) {
    if (!s.externalProductId || !s.externalVariantId) continue;
    let p = byProduct.get(s.externalProductId);
    if (!p) {
      p = { title: s.productTitle, variants: new Map() };
      byProduct.set(s.externalProductId, p);
    }
    if (!p.title && s.productTitle) p.title = s.productTitle;
    const v = p.variants.get(s.externalVariantId);
    if (!v) p.variants.set(s.externalVariantId, { title: s.variantTitle, sku: s.sku, price: s.price });
    else {
      if (!v.title && s.variantTitle) v.title = s.variantTitle;
      if (!v.sku && s.sku) v.sku = s.sku;
      if (!v.price && s.price) v.price = s.price;
    }
  }
  let products = 0;
  let variants = 0;
  for (const [externalProductId, p] of byProduct) {
    const product = await db.product.upsert({
      where: { integrationId_externalProductId: { integrationId, externalProductId } },
      create: { organizationId: ctx.organizationId, integrationId, externalProductId, title: p.title ?? `Product ${externalProductId}`, active: true, providerData: { derivedFrom: "subscriptions" }, lastSyncedAt: new Date() },
      update: { lastSyncedAt: new Date() },
      select: { id: true },
    });
    products++;
    for (const [externalVariantId, v] of p.variants) {
      await db.productVariant.upsert({
        where: { productId_externalVariantId: { productId: product.id, externalVariantId } },
        create: { organizationId: ctx.organizationId, productId: product.id, externalVariantId, title: v.title ?? "Default", sku: v.sku, price: v.price, active: true },
        update: { ...(v.sku ? { sku: v.sku } : {}), ...(v.title ? { title: v.title } : {}) },
      });
      variants++;
    }
  }
  return { products, variants };
}

// ── customers ──────────────────────────────────────────────────────────────

export async function importCustomersPage(ctx: Ctx, connector: RechargeConnector, integrationId: string, cursor: string | null, updatedSince?: Date | null): Promise<PageResult> {
  const db = dbFor(ctx);
  const iter = connector.listCustomers({ startCursor: cursor, updatedSince: updatedSince ?? undefined });
  const page = await iter.next();
  if (page.done) return { nextCursor: null, items: 0, delta: {} };
  const { items, nextCursor } = page.value;
  for (const c of items) {
    await db.customer.upsert({
      where: { integrationId_externalCustomerId: { integrationId, externalCustomerId: c.externalCustomerId } },
      create: { organizationId: ctx.organizationId, integrationId, externalCustomerId: c.externalCustomerId, email: c.email, firstName: c.firstName, lastName: c.lastName, lastSyncedAt: new Date() },
      update: { email: c.email, firstName: c.firstName, lastName: c.lastName, lastSyncedAt: new Date() },
    });
  }
  return { nextCursor, items: items.length, delta: { customers: items.length } };
}

// ── subscriptions ──────────────────────────────────────────────────────────

function toInternalStatus(s: ConnectorSubscription["status"]): "ACTIVE" | "CANCELLED" | "EXPIRED" | "UNKNOWN" {
  return s === "active" ? "ACTIVE" : s === "cancelled" ? "CANCELLED" : s === "expired" ? "EXPIRED" : "UNKNOWN";
}

export { localMidnightUtc };

export async function importSubscriptionsPage(
  ctx: Ctx & { timezone: string },
  connector: RechargeConnector,
  integrationId: string,
  status: "active" | "cancelled" | "expired",
  cursor: string | null,
  updatedSince?: Date | null,
): Promise<PageResult> {
  const db = dbFor(ctx);
  const iter = connector.listSubscriptions({ status, startCursor: cursor, updatedSince: updatedSince ?? undefined });
  const page = await iter.next();
  if (page.done) return { nextCursor: null, items: 0, delta: {} };
  const { items, nextCursor } = page.value;

  // Derive catalogue rows from the subscriptions themselves (the only product source on
  // Shopify-checkout stores, and a harmless confirmation elsewhere). Titles from a
  // live subscription never overwrite a title that /products already provided.
  await deriveCatalogue(
    ctx,
    integrationId,
    items.map((s) => ({ externalProductId: s.externalProductId, externalVariantId: s.externalVariantId, productTitle: s.productTitle, variantTitle: s.variantTitle, sku: s.sku, price: s.price })),
  );

  // resolve customer + catalogue ids for this page in two queries
  const customerIds = [...new Set(items.map((s) => s.externalCustomerId))];
  const customers = await db.customer.findMany({ where: { integrationId, externalCustomerId: { in: customerIds } }, select: { id: true, externalCustomerId: true } });
  const customerMap = new Map(customers.map((c) => [c.externalCustomerId, c.id]));
  const productIds = [...new Set(items.map((s) => s.externalProductId).filter(Boolean))];
  const products = await db.product.findMany({ where: { integrationId, externalProductId: { in: productIds } }, select: { id: true, externalProductId: true, variants: { select: { id: true, externalVariantId: true } } } });
  const productMap = new Map(products.map((p) => [p.externalProductId, p]));

  let active = 0;
  for (const s of items) {
    const internalStatus = toInternalStatus(s.status);
    if (internalStatus === "ACTIVE") active++;
    const product = productMap.get(s.externalProductId);
    const variantId = product?.variants.find((v) => v.externalVariantId === s.externalVariantId)?.id ?? null;
    const nextChargeAt = s.nextChargeDate ? localMidnightUtc(s.nextChargeDate, ctx.timezone) : null;
    const common = {
      customerId: customerMap.get(s.externalCustomerId) ?? null,
      externalCustomerId: s.externalCustomerId,
      externalAddressId: s.externalAddressId,
      status: internalStatus,
      externalStatus: s.providerStatus,
      productId: product?.id ?? null,
      variantId,
      externalProductId: s.externalProductId,
      externalVariantId: s.externalVariantId,
      productTitleSnapshot: s.productTitle,
      variantTitleSnapshot: s.variantTitle,
      skuSnapshot: s.sku,
      quantity: s.quantity,
      price: s.price,
      intervalUnit: s.intervalUnit,
      intervalFrequency: s.intervalFrequency,
      nextChargeDate: s.nextChargeDate,
      nextChargeAt,
      externalCreatedAt: s.externalCreatedAt,
      cancelledAt: s.cancelledAt,
      providerData: (s.providerData ?? undefined) as Prisma.InputJsonValue | undefined,
      lastSyncedAt: new Date(),
    };
    await db.subscription.upsert({
      where: { integrationId_externalSubscriptionId: { integrationId, externalSubscriptionId: s.externalSubscriptionId } },
      create: { organizationId: ctx.organizationId, integrationId, externalSubscriptionId: s.externalSubscriptionId, ...common },
      update: common,
    });
  }
  return { nextCursor, items: items.length, delta: { subscriptions: items.length, subscriptionsActive: active, subscriptionsInactive: items.length - active } };
}

// ── orders ─────────────────────────────────────────────────────────────────

/**
 * Walk successful orders and record one SubscriptionOrder per subscription line.
 * Only `status === "success"` lines are stored — the definition of a cycle.
 */
export async function importOrdersPage(ctx: Ctx, connector: RechargeConnector, integrationId: string, cursor: string | null, updatedSince?: Date | null): Promise<PageResult> {
  const db = dbFor(ctx);
  const iter = connector.listOrders({ status: "success", startCursor: cursor, updatedSince: updatedSince ?? undefined });
  const page = await iter.next();
  if (page.done) return { nextCursor: null, items: 0, delta: {} };
  const { items, nextCursor } = page.value;

  const lines = collectSubscriptionLines(items);
  // historical products/variants that no live subscription references any more
  await deriveCatalogue(
    ctx,
    integrationId,
    lines.map((l) => ({ externalProductId: l.data.externalProductId, externalVariantId: l.data.externalVariantId, productTitle: l.data.productTitle ?? null, variantTitle: null, sku: (l.data.providerData as { sku?: string | null } | undefined)?.sku ?? null, price: null })),
  );
  const subIds = [...new Set(lines.map((l) => l.externalSubscriptionId))];
  const subs = await db.subscription.findMany({ where: { integrationId, externalSubscriptionId: { in: subIds } }, select: { id: true, externalSubscriptionId: true } });
  const subMap = new Map(subs.map((s) => [s.externalSubscriptionId, s.id]));

  let unlinked = 0;
  for (const l of lines) {
    const subscriptionId = subMap.get(l.externalSubscriptionId) ?? null;
    if (!subscriptionId) unlinked++;
    await db.subscriptionOrder.upsert({
      where: { integrationId_externalOrderId_externalSubscriptionId: { integrationId, externalOrderId: l.externalOrderId, externalSubscriptionId: l.externalSubscriptionId } },
      create: { organizationId: ctx.organizationId, integrationId, subscriptionId, externalOrderId: l.externalOrderId, externalSubscriptionId: l.externalSubscriptionId, ...l.data },
      update: { subscriptionId, ...l.data },
    });
  }
  return { nextCursor, items: items.length, delta: { orders: items.length, orderLines: lines.length, orderLinesUnlinked: unlinked } };
}

type SubscriptionLine = {
  externalOrderId: string;
  externalSubscriptionId: string;
  data: Omit<Prisma.SubscriptionOrderUncheckedCreateInput, "organizationId" | "integrationId" | "subscriptionId" | "externalOrderId" | "externalSubscriptionId">;
};

export function collectSubscriptionLines(orders: ConnectorOrder[]): SubscriptionLine[] {
  const out: SubscriptionLine[] = [];
  for (const o of orders) {
    if (o.status !== "success" || !o.processedAt) continue;
    // one row per (order, subscription) — collapse duplicate lines for the same subscription
    const seen = new Set<string>();
    for (const li of o.lineItems) {
      if (li.purchaseItemType !== "subscription" || !li.purchaseItemId) continue;
      if (seen.has(li.purchaseItemId)) continue;
      seen.add(li.purchaseItemId);
      out.push({
        externalOrderId: o.externalOrderId,
        externalSubscriptionId: li.purchaseItemId,
        data: {
          externalChargeId: o.externalChargeId,
          externalCustomerId: o.externalCustomerId,
          externalAddressId: o.externalAddressId,
          orderKind: o.kind,
          orderStatus: o.status,
          processedAt: o.processedAt,
          externalProductId: li.externalProductId ?? "",
          externalVariantId: li.externalVariantId ?? "",
          quantity: li.quantity,
          productTitle: li.title,
          providerData: { platformOrderId: o.platformOrderId, scheduledAt: o.scheduledAt, sku: li.sku },
        },
      });
    }
  }
  return out;
}

// ── one-times (count only) ─────────────────────────────────────────────────

/**
 * Phase 2 reads one-times purely to report how many exist (pre-existing manual
 * fulfilment markers, later duplicate reconciliation). Nothing is stored yet.
 */
export async function countOnetimesPage(_ctx: Ctx, connector: RechargeConnector, _integrationId: string, cursor: string | null, updatedSince?: Date | null): Promise<PageResult> {
  const iter = connector.listOnetimes({ startCursor: cursor, updatedSince: updatedSince ?? undefined });
  const page = await iter.next();
  if (page.done) return { nextCursor: null, items: 0, delta: {} };
  const { items, nextCursor } = page.value;
  return { nextCursor, items: items.length, delta: { onetimes: items.length } };
}

// ── journeys ───────────────────────────────────────────────────────────────

/** Relink SubscriptionOrders that arrived before their Subscription row (or were unlinked). */
export async function relinkOrphanOrders(ctx: Ctx, integrationId: string): Promise<number> {
  const db = dbFor(ctx);
  const orphans = await db.subscriptionOrder.findMany({ where: { integrationId, subscriptionId: null }, select: { id: true, externalSubscriptionId: true }, take: 5000 });
  if (orphans.length === 0) return 0;
  const ids = [...new Set(orphans.map((o) => o.externalSubscriptionId))];
  const subs = await db.subscription.findMany({ where: { integrationId, externalSubscriptionId: { in: ids } }, select: { id: true, externalSubscriptionId: true } });
  const map = new Map(subs.map((s) => [s.externalSubscriptionId, s.id]));
  let linked = 0;
  for (const o of orphans) {
    const sid = map.get(o.externalSubscriptionId);
    if (!sid) continue;
    await db.subscriptionOrder.update({ where: { id: o.id }, data: { subscriptionId: sid } });
    linked++;
  }
  return linked;
}

/** Recalculate journeys for a batch (by offset) of the integration's subscriptions. */
export async function recalculateJourneysBatch(ctx: Ctx, integrationId: string, offset: number, batchSize: number) {
  const db = dbFor(ctx);
  const subs = await db.subscription.findMany({ where: { integrationId }, orderBy: { id: "asc" }, skip: offset, take: batchSize, select: { id: true } });
  if (subs.length === 0) return { processed: 0, mapped: 0, unmapped: 0, changed: 0, unresolvedOrders: 0, orphanJourneysKept: 0, done: true };
  const agg = await recalculateJourneysForSubscriptions(ctx, integrationId, subs.map((s) => s.id));
  return { ...agg, done: subs.length < batchSize };
}

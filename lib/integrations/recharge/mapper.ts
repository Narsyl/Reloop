/**
 * Recharge → internal DTOs. The only file that knows Recharge field names.
 *
 * External ids arrive already normalised to `string | null` by the schemas
 * (see ids.ts). This file decides which are REQUIRED for domain correctness and
 * throws a typed ExternalIdError — naming the resource, field and record id —
 * when one is missing. Nothing here ever emits "", "null" or "undefined".
 */
import type {
  ConnectorCustomer,
  ConnectorOnetime,
  ConnectorOrder,
  ConnectorOrderKind,
  ConnectorOrderLine,
  ConnectorProduct,
  ConnectorStore,
  ConnectorSubscription,
  ConnectorSubscriptionStatus,
  ConnectorVariant,
} from "@/lib/integrations/types";
import { optionalExternalId, requiredExternalId } from "./ids";
import type { RcCustomer, RcOnetime, RcOrder, RcProduct, RcStore, RcSubscription } from "./schemas";

export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Recharge gives dates as "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm:ss"; keep the calendar date only. */
export function dateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m ? m[1] : null;
}

function num(v: number | string | null | undefined, fallback: number): number {
  if (v === null || v === undefined || v === "") return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function decimalString(v: number | string | null | undefined): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

export function mapStore(s: RcStore): ConnectorStore {
  return {
    externalStoreId: s.domain ?? (s.id ? String(s.id) : "unknown-store"),
    name: s.name ?? s.domain ?? "Recharge store",
    domain: s.domain ?? null,
    email: s.email ?? s.shop_email ?? null,
    currency: s.currency ?? null,
    timezone: s.iana_timezone ?? s.timezone ?? null,
  };
}

export function mapCustomer(c: RcCustomer): ConnectorCustomer {
  return {
    externalCustomerId: c.id,
    email: c.email ?? null,
    firstName: c.first_name ?? null,
    lastName: c.last_name ?? null,
    externalCreatedAt: parseDate(c.created_at),
    externalUpdatedAt: parseDate(c.updated_at),
  };
}

/**
 * Products: a product without a commerce id cannot be joined to any subscription,
 * so it is skipped (returns null) and counted by the caller — catalogue only,
 * not required for cycle correctness. Variants without an id are likewise
 * skipped and counted in `skippedVariants`. Malformed ids never reach here
 * (schema rejects them).
 */
export function mapProduct(p: RcProduct): ConnectorProduct | null {
  const externalProductId = optionalExternalId(p.external_product_id, { resource: "product", field: "external_product_id", recordId: p.id });
  if (!externalProductId) return null;
  const variants: ConnectorVariant[] = [];
  let skippedVariants = 0;
  for (const v of p.variants ?? []) {
    const externalVariantId = optionalExternalId(v.external_variant_id, { resource: "product.variant", field: "external_variant_id", recordId: p.id });
    if (!externalVariantId) {
      skippedVariants++;
      continue;
    }
    variants.push({
      externalVariantId,
      title: v.title ?? "Default",
      sku: v.sku ?? null,
      price: decimalString(v.prices?.unit_price ?? v.price ?? null),
    });
  }
  return {
    externalProductId,
    providerProductId: p.id ?? null,
    title: p.title ?? `Product ${externalProductId}`,
    active: !p.deleted_at,
    variants,
    skippedVariants,
    providerData: { providerProductId: p.id ?? null, handle: p.handle ?? null, publishedAt: p.published_at ?? null },
  };
}

function mapSubscriptionStatus(raw: string): ConnectorSubscriptionStatus {
  const s = raw.toLowerCase();
  if (s === "active") return "active";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  if (s === "expired") return "expired";
  return "unknown";
}

/** Subscriptions: product AND variant ids are required — without them the subscription cannot be placed in a program. */
export function mapSubscription(s: RcSubscription): ConnectorSubscription {
  const externalProductId = requiredExternalId(s.external_product_id, { resource: "subscription", field: "external_product_id", recordId: s.id });
  const externalVariantId = requiredExternalId(s.external_variant_id, { resource: "subscription", field: "external_variant_id", recordId: s.id });
  return {
    externalSubscriptionId: s.id,
    externalCustomerId: s.customer_id,
    externalAddressId: s.address_id,
    status: mapSubscriptionStatus(s.status),
    providerStatus: s.status,
    externalProductId,
    externalVariantId,
    productTitle: s.product_title ?? "Unknown product",
    variantTitle: s.variant_title ?? null,
    sku: s.sku ?? null,
    quantity: num(s.quantity, 1),
    price: decimalString(s.price),
    intervalUnit: s.order_interval_unit ?? null,
    intervalFrequency: s.order_interval_frequency === null || s.order_interval_frequency === undefined ? null : num(s.order_interval_frequency, 0) || null,
    nextChargeDate: dateOnly(s.next_charge_scheduled_at),
    externalCreatedAt: parseDate(s.created_at),
    externalUpdatedAt: parseDate(s.updated_at),
    cancelledAt: parseDate(s.cancelled_at),
    providerData: {
      cancellationReason: s.cancellation_reason ?? null,
      chargeIntervalFrequency: s.charge_interval_frequency ?? null,
      hasQueuedCharge: s.has_queued_charge ?? null,
      isSkippable: s.is_skippable ?? null,
      isSwappable: s.is_swappable ?? null,
      nextChargeScheduledAtRaw: s.next_charge_scheduled_at ?? null,
    },
  };
}

function mapOrderKind(type: string | null | undefined): ConnectorOrderKind {
  return (type ?? "").toLowerCase() === "checkout" ? "CHECKOUT" : "RECURRING";
}

/**
 * Orders: for SUBSCRIPTION line items the product/variant ids are required — a
 * successful order line is a delivery cycle and must be attributable to a
 * program. For one-time/unknown lines they are optional.
 */
export function mapOrder(o: RcOrder): ConnectorOrder {
  const lineItems: ConnectorOrderLine[] = (o.line_items ?? []).map((li, index) => {
    const type = (li.purchase_item_type ?? "").toLowerCase();
    const purchaseItemId = li.purchase_item_id ?? li.subscription_id ?? null;
    const purchaseItemType: ConnectorOrderLine["purchaseItemType"] = type === "subscription" || type === "onetime" ? type : li.subscription_id ? "subscription" : "unknown";
    const ctx = (field: string) => ({ resource: "order.line_item", field, recordId: `${o.id}#${index}${purchaseItemId ? ` (purchase_item ${purchaseItemId})` : ""}` });
    const externalProductId = purchaseItemType === "subscription" ? requiredExternalId(li.external_product_id, ctx("external_product_id")) : optionalExternalId(li.external_product_id, ctx("external_product_id"));
    const externalVariantId = purchaseItemType === "subscription" ? requiredExternalId(li.external_variant_id, ctx("external_variant_id")) : optionalExternalId(li.external_variant_id, ctx("external_variant_id"));
    return {
      purchaseItemId,
      purchaseItemType,
      externalProductId,
      externalVariantId,
      quantity: num(li.quantity, 1),
      title: li.title ?? null,
      sku: li.sku ?? null,
    };
  });
  return {
    externalOrderId: o.id,
    externalCustomerId: o.customer_id ?? o.customer?.id ?? null,
    externalAddressId: o.address_id ?? null,
    externalChargeId: o.charge_id ?? o.charge?.id ?? null,
    platformOrderId: o.external_order_id ?? null,
    status: o.status.toLowerCase(),
    kind: mapOrderKind(o.type),
    processedAt: parseDate(o.processed_at) ?? parseDate(o.created_at),
    scheduledAt: dateOnly(o.scheduled_at),
    lineItems,
  };
}

/** One-times: ids are optional in Phase 2 (read for discovery only). */
export function mapOnetime(t: RcOnetime): ConnectorOnetime {
  return {
    externalOnetimeId: t.id,
    externalAddressId: t.address_id,
    externalCustomerId: t.customer_id ?? null,
    externalProductId: optionalExternalId(t.external_product_id, { resource: "onetime", field: "external_product_id", recordId: t.id }),
    externalVariantId: optionalExternalId(t.external_variant_id, { resource: "onetime", field: "external_variant_id", recordId: t.id }),
    nextChargeDate: dateOnly(t.next_charge_scheduled_at),
    productTitle: t.product_title ?? null,
    sku: t.sku ?? null,
    quantity: num(t.quantity, 1),
    price: decimalString(t.price),
    externalCreatedAt: parseDate(t.created_at),
  };
}

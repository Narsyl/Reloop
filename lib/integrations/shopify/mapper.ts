import type { z } from "zod";
import { gidToId } from "./client";
import type { productNodeSchema, shopSchema, variantNodeSchema } from "./schemas";
import type { ShopifyProductStatus, ShopifyProductSummary, ShopifyStore, ShopifyVariantSummary } from "./types";

export function mapStore(data: z.infer<typeof shopSchema>): ShopifyStore {
  const s = data.shop;
  return {
    shopGid: s.id,
    name: s.name,
    myshopifyDomain: s.myshopifyDomain,
    primaryDomainHost: s.primaryDomain?.host ?? null,
    currencyCode: s.currencyCode,
    planDisplayName: s.plan?.displayName ?? null,
    ianaTimezone: s.ianaTimezone ?? null,
  };
}

export function mapVariant(v: z.infer<typeof variantNodeSchema>): ShopifyVariantSummary {
  return {
    variantId: gidToId(v.id),
    variantGid: v.id,
    title: v.title ?? "",
    sku: v.sku && v.sku.trim() ? v.sku.trim() : null,
    price: typeof v.price === "number" ? v.price.toFixed(2) : v.price,
    inventoryItemId: v.inventoryItem?.id ?? null,
    inventoryTracked: v.inventoryItem?.tracked ?? null,
    requiresShipping: v.inventoryItem?.requiresShipping ?? null,
  };
}

export function mapProduct(p: z.infer<typeof productNodeSchema>, withPublication: boolean): ShopifyProductSummary {
  const status = (["ACTIVE", "ARCHIVED", "DRAFT", "UNLISTED"].includes(p.status) ? p.status : "ACTIVE") as ShopifyProductStatus;
  return {
    productId: gidToId(p.id),
    productGid: p.id,
    title: p.title,
    handle: p.handle,
    status,
    productType: p.productType?.trim() || null,
    tags: p.tags ?? [],
    vendor: p.vendor ?? null,
    onlineStoreUrl: p.onlineStoreUrl ?? null,
    publishedOnlineStore: withPublication ? (p.publishedOnPublication ?? false) : null,
    variants: p.variants.nodes.map(mapVariant),
    updatedAt: p.updatedAt ?? null,
  };
}

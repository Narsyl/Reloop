/**
 * Shopify connector (Phase 4c): catalogue + fulfilment-marker identity/verification ONLY.
 *
 * Recharge remains the subscription, lifecycle, upcoming-charge and (eventual) one-time write
 * authority. This connector never reads orders/customers/fulfilments, never edits orders, and never
 * triggers automation. Its write surface is exactly: create/update a marker product (+ variant
 * price/SKU/inventory) and publish it to the Online Store.
 */
import { ShopifyAdminClient, type ShopifyClientOptions } from "./client";
import { getStore, probeCapabilities } from "./store";
import { findOnlineStorePublication, listPublications, publishProduct } from "./publications";
import { createMarkerProduct, getProduct, getProductByVariantId, quoteSearchValue, searchProducts, updateMarkerProduct } from "./products";
import type { MarkerProductSpec, ShopifyCredentials, ShopifyProductStatus } from "./types";

export type ShopifyConnector = ReturnType<typeof createShopifyConnector>;

export function createShopifyConnector(client: ShopifyAdminClient, defaults: { onlineStorePublicationId?: string | null } = {}) {
  const pub = defaults.onlineStorePublicationId ?? null;
  return {
    provider: "SHOPIFY" as const,
    client,
    shopDomain: client.shop,
    apiVersion: client.version,
    getStore: () => getStore(client),
    probeCapabilities: () => probeCapabilities(client),
    listPublications: () => listPublications(client),
    findOnlineStorePublication: () => findOnlineStorePublication(client),
    searchProducts: (query: string, first?: number) => searchProducts(client, query, { first, onlineStorePublicationId: pub }),
    searchBySku: (sku: string) => searchProducts(client, `sku:${quoteSearchValue(sku)}`, { first: 10, onlineStorePublicationId: pub }),
    searchByTitle: (title: string) => searchProducts(client, `title:${quoteSearchValue(title)}`, { first: 10, onlineStorePublicationId: pub }),
    getProduct: (productId: string) => getProduct(client, productId, { onlineStorePublicationId: pub }),
    getProductByVariantId: (variantId: string) => getProductByVariantId(client, variantId, { onlineStorePublicationId: pub }),
    createMarkerProduct: (spec: MarkerProductSpec) => createMarkerProduct(client, spec, pub),
    updateMarkerProduct: (productId: string, variantId: string, changes: { title?: string; status?: ShopifyProductStatus; sku?: string; price?: string; tags?: string[]; productType?: string }) => updateMarkerProduct(client, productId, variantId, changes, pub),
    publishToOnlineStore: (productId: string) => {
      if (!pub) throw new Error("Online Store publication id unknown");
      return publishProduct(client, productId, pub);
    },
  };
}

export function createShopifyConnectorFromCredentials(credentials: ShopifyCredentials, opts: Omit<ShopifyClientOptions, "credentials"> & { onlineStorePublicationId?: string | null } = {}) {
  const { onlineStorePublicationId, ...clientOpts } = opts;
  return createShopifyConnector(new ShopifyAdminClient({ credentials, ...clientOpts }), { onlineStorePublicationId });
}

export { ShopifyAdminClient, SHOPIFY_API_VERSION, MUTATION_ALLOWLIST, normalizeShopDomain } from "./client";
export { ShopifyError, isShopifyError } from "./errors";
export * from "./types";

/**
 * Shopify connector (revised Phase 4c): READ-ONLY catalogue access for reward-item bindings.
 *
 * Recharge remains the subscription, lifecycle, upcoming-charge and (eventual) one-time write authority.
 * This connector reads store identity, granted scopes, products/variants and (optionally) publications.
 * It has no write surface at all — the client refuses mutation documents — and never touches orders,
 * customers or fulfilments. It never computes cycles, charges, one-times or actions.
 */
import { ShopifyAdminClient, type ShopifyClientOptions } from "./client";
import { createTokenProvider } from "./auth";
import { getStore, probeCapabilities } from "./store";
import { findOnlineStorePublication, listPublications } from "./publications";
import { buildSearchQuery, getProduct, getProductByVariantId, searchProducts } from "./products";
import type { ShopifyCredentials, ShopifyTokenCacheStore } from "./types";

export type ShopifyConnector = ReturnType<typeof createShopifyConnector>;

export function createShopifyConnector(client: ShopifyAdminClient, defaults: { onlineStorePublicationId?: string | null } = {}) {
  const pub = defaults.onlineStorePublicationId ?? null;
  return {
    provider: "SHOPIFY" as const,
    client,
    shopDomain: client.shop,
    apiVersion: client.version,
    authMode: client.auth.authMode,
    tokenInfo: () => client.auth.describe(),
    getStore: () => getStore(client),
    probeCapabilities: (opts?: { tokenScopes?: string[] }) => probeCapabilities(client, opts),
    listPublications: () => listPublications(client),
    findOnlineStorePublication: () => findOnlineStorePublication(client),
    /** raw Shopify search query (e.g. `sku:"X"`, `title:*cup*`) */
    searchProducts: (query: string, first?: number) => searchProducts(client, query, { first, onlineStorePublicationId: pub }),
    /** operator search-box text → products */
    search: (term: string, first?: number) => {
      const q = buildSearchQuery(term);
      return q ? searchProducts(client, q, { first, onlineStorePublicationId: pub }) : Promise.resolve([]);
    },
    getProduct: (productId: string) => getProduct(client, productId, { onlineStorePublicationId: pub }),
    getProductByVariantId: (variantId: string) => getProductByVariantId(client, variantId, { onlineStorePublicationId: pub }),
  };
}

export function createShopifyConnectorFromCredentials(credentials: ShopifyCredentials, opts: Omit<ShopifyClientOptions, "shopDomain" | "tokenProvider"> & { onlineStorePublicationId?: string | null; tokenCache?: ShopifyTokenCacheStore } = {}) {
  const { onlineStorePublicationId, tokenCache, ...clientOpts } = opts;
  const tokenProvider = createTokenProvider(credentials, { cache: tokenCache, fetchImpl: clientOpts.fetchImpl, log: clientOpts.log });
  return createShopifyConnector(new ShopifyAdminClient({ shopDomain: credentials.shopDomain, tokenProvider, ...clientOpts }), { onlineStorePublicationId });
}

export { ShopifyAdminClient, SHOPIFY_API_VERSION, isMutationDocument, gidToId } from "./client";
export { normalizeShopDomain, exchangeClientCredentials, createTokenProvider, ClientCredentialsTokenProvider, StaticTokenProvider, TOKEN_REFRESH_MARGIN_MS } from "./auth";
export { buildSearchQuery, quoteSearchValue } from "./products";
export { ShopifyError, isShopifyError } from "./errors";
export * from "./types";

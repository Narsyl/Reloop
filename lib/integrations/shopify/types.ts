/**
 * Shopify connector types (revised Phase 4c): READ-ONLY catalogue access used to bind physical reward
 * items (Whisk, Cup, Spoon…) to their existing Shopify product variants and to verify them.
 *
 * Authentication: Shopify's client-credentials grant (Dev Dashboard app: Client ID + Client secret →
 * short-lived Admin API access token exchanged server-side). The durable credential is the client
 * id/secret pair; the access token is ephemeral infrastructure state. A merchant-OAuth-issued token
 * slots into the same `TokenProvider` seam later (authMode ACCESS_TOKEN).
 */

export type ShopifyAuthMode = "CLIENT_CREDENTIALS" | "ACCESS_TOKEN";

export type ShopifyCredentials =
  | { authMode: "CLIENT_CREDENTIALS"; shopDomain: string; clientId: string; clientSecret: string }
  /** A token someone else issued (tests, future merchant OAuth). Not the normal credential model. */
  | { authMode: "ACCESS_TOKEN"; shopDomain: string; accessToken: string };

export type ShopifyAccessToken = { accessToken: string; scope: string[]; expiresAt: Date | null };

/** Supplies a valid Admin API access token for each request; may refresh behind the scenes. */
export type ShopifyTokenProvider = {
  authMode: ShopifyAuthMode;
  getAccessToken(opts?: { forceRefresh?: boolean }): Promise<string>;
  /** informational (never the token itself) */
  describe(): { authMode: ShopifyAuthMode; expiresAt: Date | null; cached: boolean };
};

/** Persisted token cache (encrypted by the domain layer). `null` = nothing cached. */
export type ShopifyTokenCacheStore = {
  load(): Promise<{ accessToken: string; expiresAt: Date | null; scope: string[] } | null>;
  save(token: ShopifyAccessToken): Promise<void>;
  clear(): Promise<void>;
};

export type ShopifyStore = {
  shopGid: string;
  name: string;
  myshopifyDomain: string;
  primaryDomainHost: string | null;
  currencyCode: string;
  planDisplayName: string | null;
  ianaTimezone: string | null;
};

export type ShopifyPublication = { id: string; name: string };

export type ShopifyProductStatus = "ACTIVE" | "ARCHIVED" | "DRAFT" | "UNLISTED" | string;

export type ShopifyVariantSummary = {
  /** numeric id — the canonical fulfilment identity */
  variantId: string;
  variantGid: string;
  title: string | null;
  sku: string | null;
  price: string;
  inventoryItemId: string | null;
  inventoryTracked: boolean | null;
  requiresShipping: boolean | null;
  availableForSale: boolean | null;
};

export type ShopifyProductSummary = {
  productId: string;
  productGid: string;
  title: string;
  handle: string;
  status: ShopifyProductStatus;
  productType: string | null;
  tags: string[];
  vendor: string | null;
  onlineStoreUrl: string | null;
  /** null when the Online Store publication is unknown / read_publications not granted */
  publishedOnlineStore: boolean | null;
  featuredImageUrl: string | null;
  variants: ShopifyVariantSummary[];
  updatedAt: string | null;
};

export type CapabilityState = "available" | "unavailable" | "not-granted";

export type ShopifyCapabilityReport = {
  store: ShopifyStore;
  authMode: ShopifyAuthMode;
  /** scopes the token actually carries (from the token response and/or currentAppInstallation) */
  grantedScopes: string[];
  tokenExpiresAt: string | null;
  storeIdentity: "available" | "unavailable";
  productsRead: "available" | "unavailable";
  /** optional — used only for the "published to Online Store" hint */
  publicationsRead: CapabilityState;
  onlineStorePublicationId: string | null;
  /** write or non-catalogue scopes this connector never uses (should be removed from the app) */
  unexpectedScopes: string[];
  notRequested: readonly string[];
  requiredOk: boolean;
  missingScopes: string[];
  checkedAt: string;
};

/** The only scope the connector needs. */
export const REQUIRED_SHOPIFY_SCOPES = ["read_products"] as const;
/** Optional: lets the capability/verification panel show Online Store publication state. */
export const OPTIONAL_SHOPIFY_SCOPES = ["read_publications"] as const;
/** Everything this connector deliberately never requests. */
export const NOT_REQUESTED_AREAS = ["write_products", "write_publications", "orders", "customers", "fulfillments", "inventory", "discounts", "draft_orders", "subscriptions", "checkout", "themes"] as const;

/**
 * Shopify connector DTOs (Phase 4c) — the ONLY shapes the domain sees. Shopify GraphQL payloads are
 * mapped here and never leak further. Scope of the connector: store identity, products/variants
 * (read + marker create/update), publications. Nothing about orders, customers or fulfilments.
 */

export type ShopifyCredentials = {
  /** myshopify domain, e.g. "ancient-extracts.myshopify.com" */
  shopDomain: string;
  /** Admin API access token (custom app "shpat_…" today; OAuth-issued later — same shape) */
  accessToken: string;
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

export type ShopifyProductStatus = "ACTIVE" | "ARCHIVED" | "DRAFT" | "UNLISTED";

export type ShopifyVariantSummary = {
  variantId: string; // numeric, canonical marker identity ("56259577545090")
  variantGid: string;
  title: string;
  sku: string | null;
  price: string;
  inventoryItemId: string | null;
  inventoryTracked: boolean | null;
  requiresShipping: boolean | null;
};

export type ShopifyProductSummary = {
  productId: string; // numeric
  productGid: string;
  title: string;
  handle: string;
  status: ShopifyProductStatus;
  productType: string | null;
  tags: string[];
  vendor: string | null;
  onlineStoreUrl: string | null;
  /** published to the Online Store publication (null when the publication id was not resolved) */
  publishedOnlineStore: boolean | null;
  variants: ShopifyVariantSummary[];
  updatedAt: string | null;
};

/** Least-privilege capability report shown in Settings → Integrations. */
export type ShopifyCapabilityReport = {
  store: ShopifyStore;
  grantedScopes: string[];
  storeIdentity: "available";
  productsRead: "available" | "unavailable";
  productsWrite: "available" | "unavailable";
  publicationsRead: "available" | "unavailable";
  publicationsWrite: "available" | "unavailable";
  /** scopes granted beyond what this connector needs — flagged, never used */
  unexpectedScopes: string[];
  notRequested: readonly ["orders", "customers", "fulfillments", "draft_orders", "discounts", "inventory", "themes", "checkouts"];
  onlineStorePublicationId: string | null;
  requiredOk: boolean;
  missingScopes: string[];
  checkedAt: string;
};

export const REQUIRED_SHOPIFY_SCOPES = ["read_products", "write_products", "read_publications", "write_publications"] as const;
export const NOT_REQUESTED_AREAS = ["orders", "customers", "fulfillments", "draft_orders", "discounts", "inventory", "themes", "checkouts"] as const;

/** What the platform wants a fulfilment-marker product to look like in Shopify. */
export type MarkerProductSpec = {
  title: string; // "Morning Magic 2"
  sku: string; // "MM-CYCLE-02"
  price: string; // "0.00"
  status: ShopifyProductStatus; // UNLISTED (target), never DRAFT merely to hide
  productType: string; // "Fulfillment Marker"
  tags: string[]; // ["subscription-ops-marker", …] — classification only, never identity
  descriptionHtml?: string;
  vendor?: string;
  publishToOnlineStore: boolean;
};

export const MARKER_PRODUCT_TYPE = "Fulfillment Marker";
export const MARKER_TAG = "subscription-ops-marker";

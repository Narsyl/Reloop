/**
 * Store identity + least-privilege capability report. Read-only.
 */
import type { ShopifyAdminClient } from "./client";
import { accessScopesSchema, productsSearchSchema, shopSchema } from "./schemas";
import { mapStore } from "./mapper";
import { findOnlineStorePublication } from "./publications";
import { isShopifyError } from "./errors";
import { NOT_REQUESTED_AREAS, REQUIRED_SHOPIFY_SCOPES, type ShopifyCapabilityReport, type ShopifyStore } from "./types";

const SHOP_QUERY = `query SubscriptionOpsShop { shop { id name myshopifyDomain primaryDomain { host } currencyCode plan { displayName } ianaTimezone } }`;
const SCOPES_QUERY = `query SubscriptionOpsScopes { currentAppInstallation { accessScopes { handle } } }`;
const PRODUCTS_PROBE = `query SubscriptionOpsProductsProbe { products(first: 1) { nodes { id title handle status productType tags vendor onlineStoreUrl updatedAt variants(first: 1) { nodes { id title sku price inventoryItem { id tracked requiresShipping } } } } } }`;

export async function getStore(client: ShopifyAdminClient): Promise<ShopifyStore> {
  return mapStore(await client.query("shop", SHOP_QUERY, {}, shopSchema));
}

export async function getAccessScopes(client: ShopifyAdminClient): Promise<string[]> {
  const data = await client.query("accessScopes", SCOPES_QUERY, {}, accessScopesSchema);
  return data.currentAppInstallation.accessScopes.map((s) => s.handle).sort();
}

/**
 * Empirical + declared capability probe: store identity (required), granted scopes, a products
 * read probe, the Online Store publication lookup. Never performs a write to probe write access —
 * write capability is reported from the granted scopes.
 */
export async function probeCapabilities(client: ShopifyAdminClient): Promise<ShopifyCapabilityReport> {
  const store = await getStore(client);
  const grantedScopes = await getAccessScopes(client);
  const has = (s: string) => grantedScopes.includes(s);
  let productsRead: "available" | "unavailable" = has("read_products") || has("write_products") ? "available" : "unavailable";
  try {
    await client.query("productsProbe", PRODUCTS_PROBE, {}, productsSearchSchema);
    productsRead = "available";
  } catch (e) {
    if (isShopifyError(e) && e.kind === "PERMISSION_ERROR") productsRead = "unavailable";
    else throw e;
  }
  let publicationsRead: "available" | "unavailable" = has("read_publications") || has("write_publications") ? "available" : "unavailable";
  let onlineStorePublicationId: string | null = null;
  try {
    onlineStorePublicationId = (await findOnlineStorePublication(client))?.id ?? null;
    publicationsRead = "available";
  } catch (e) {
    if (isShopifyError(e) && e.kind === "PERMISSION_ERROR") publicationsRead = "unavailable";
    else throw e;
  }
  const productsWrite = has("write_products") ? "available" : "unavailable";
  const publicationsWrite = has("write_publications") ? "available" : "unavailable";
  const required = new Set<string>(REQUIRED_SHOPIFY_SCOPES);
  const missingScopes = [...required].filter((s) => !has(s));
  // scopes beyond least privilege are flagged (never used): anything that is not a products/publications scope
  const unexpectedScopes = grantedScopes.filter((s) => !/^(read|write)_(products|publications|product_listings)$/.test(s));
  return {
    store,
    grantedScopes,
    storeIdentity: "available",
    productsRead,
    productsWrite,
    publicationsRead,
    publicationsWrite,
    unexpectedScopes,
    notRequested: NOT_REQUESTED_AREAS,
    onlineStorePublicationId,
    requiredOk: missingScopes.length === 0 && productsRead === "available" && publicationsRead === "available" && onlineStorePublicationId !== null,
    missingScopes,
    checkedAt: new Date().toISOString(),
  };
}

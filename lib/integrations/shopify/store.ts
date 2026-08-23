/**
 * Store identity + least-privilege capability report. Read-only.
 *
 * Required: store identity + `read_products` (verified empirically with a 1-product read).
 * Optional: `read_publications` (only used to show "published to Online Store" on bindings).
 * Everything else is reported as "never requested"; write scopes that happen to be granted are flagged
 * as unexpected so the operator can remove them from the app.
 */
import type { ShopifyAdminClient } from "./client";
import { accessScopesSchema, productsSearchSchema, shopSchema } from "./schemas";
import { mapStore } from "./mapper";
import { findOnlineStorePublication } from "./publications";
import { isShopifyError } from "./errors";
import { NOT_REQUESTED_AREAS, OPTIONAL_SHOPIFY_SCOPES, REQUIRED_SHOPIFY_SCOPES, type CapabilityState, type ShopifyCapabilityReport, type ShopifyStore } from "./types";

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

export async function probeCapabilities(client: ShopifyAdminClient, opts: { tokenScopes?: string[] } = {}): Promise<ShopifyCapabilityReport> {
  const store = await getStore(client);
  let grantedScopes: string[];
  try {
    grantedScopes = await getAccessScopes(client);
  } catch (e) {
    // some token types cannot read currentAppInstallation; fall back to the scopes the token response declared
    if (isShopifyError(e) && (e.kind === "PERMISSION_ERROR" || e.kind === "VALIDATION_ERROR") && opts.tokenScopes) grantedScopes = [...opts.tokenScopes].sort();
    else throw e;
  }
  if (opts.tokenScopes?.length) grantedScopes = [...new Set([...grantedScopes, ...opts.tokenScopes])].sort();
  const has = (s: string) => grantedScopes.includes(s);

  let productsRead: "available" | "unavailable" = has("read_products") || has("write_products") ? "available" : "unavailable";
  try {
    await client.query("productsProbe", PRODUCTS_PROBE, {}, productsSearchSchema);
    productsRead = "available";
  } catch (e) {
    if (isShopifyError(e) && e.kind === "PERMISSION_ERROR") productsRead = "unavailable";
    else throw e;
  }

  let publicationsRead: CapabilityState = has("read_publications") || has("write_publications") ? "available" : "not-granted";
  let onlineStorePublicationId: string | null = null;
  if (publicationsRead === "available") {
    try {
      onlineStorePublicationId = (await findOnlineStorePublication(client))?.id ?? null;
    } catch (e) {
      if (isShopifyError(e) && e.kind === "PERMISSION_ERROR") publicationsRead = "unavailable";
      else throw e;
    }
  }

  const allowed = new Set<string>([...REQUIRED_SHOPIFY_SCOPES, ...OPTIONAL_SHOPIFY_SCOPES]);
  const unexpectedScopes = grantedScopes.filter((s) => !allowed.has(s));
  const missingScopes = REQUIRED_SHOPIFY_SCOPES.filter((s) => !has(s) && !(s === "read_products" && productsRead === "available"));
  const describe = client.auth.describe();
  return {
    store,
    authMode: describe.authMode,
    grantedScopes,
    tokenExpiresAt: describe.expiresAt?.toISOString() ?? null,
    storeIdentity: "available",
    productsRead,
    publicationsRead,
    onlineStorePublicationId,
    unexpectedScopes,
    notRequested: NOT_REQUESTED_AREAS,
    requiredOk: productsRead === "available",
    missingScopes,
    checkedAt: new Date().toISOString(),
  };
}

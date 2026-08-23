/**
 * Products — READ-ONLY search and lookups used to bind physical reward items to the existing Shopify
 * variants (Whisk, Cup, Spoon…) and to verify those bindings later. No product mutation exists here.
 */
import { productGid, variantGid, type ShopifyAdminClient } from "./client";
import { mapProduct } from "./mapper";
import { productByIdSchema, productsSearchSchema, variantProductSchema } from "./schemas";
import type { ShopifyProductSummary } from "./types";

const PRODUCT_FIELDS = `
  id title handle status productType tags vendor onlineStoreUrl updatedAt
  publishedOnPublication(publicationId: $publicationId) @include(if: $withPublication)
  featuredMedia { preview { image { url } } }
  variants(first: 50) { nodes { id title sku price availableForSale inventoryItem { id tracked requiresShipping } } }
`;
const SEARCH_QUERY = `query SubscriptionOpsSearchProducts($query: String!, $first: Int!, $publicationId: ID!, $withPublication: Boolean!) { products(first: $first, query: $query, sortKey: RELEVANCE) { nodes { ${PRODUCT_FIELDS} } } }`;
const PRODUCT_QUERY = `query SubscriptionOpsProduct($id: ID!, $publicationId: ID!, $withPublication: Boolean!) { product(id: $id) { ${PRODUCT_FIELDS} } }`;
const VARIANT_QUERY = `query SubscriptionOpsVariant($id: ID!, $publicationId: ID!, $withPublication: Boolean!) { productVariant(id: $id) { id product { ${PRODUCT_FIELDS} } } }`;

// Shopify requires a non-null ID variable even when @include skips the field; use a harmless placeholder.
const NO_PUBLICATION = "gid://shopify/Publication/0";
const pubVars = (publicationId: string | null) => ({ publicationId: publicationId ?? NO_PUBLICATION, withPublication: !!publicationId });

/** Escape a value for Shopify's search query syntax (quoted, backslash/quote escaped). */
export function quoteSearchValue(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Turn an operator's search box text into a Shopify products search query:
 *   "cup"            → title:*cup* OR sku:*cup*   (free text: partial title/SKU match)
 *   "sku:ABC-1"      → used verbatim (any explicit field query)
 */
export function buildSearchQuery(term: string): string {
  const t = term.trim();
  if (!t) return "";
  if (/^[a-z_]+:/i.test(t)) return t;
  const safe = t.replace(/[\\"*]/g, "");
  return `title:*${safe}* OR sku:*${safe}*`;
}

export async function searchProducts(client: ShopifyAdminClient, query: string, opts: { first?: number; onlineStorePublicationId?: string | null } = {}): Promise<ShopifyProductSummary[]> {
  const data = await client.query("searchProducts", SEARCH_QUERY, { query, first: opts.first ?? 10, ...pubVars(opts.onlineStorePublicationId ?? null) }, productsSearchSchema);
  return data.products.nodes.map((n) => mapProduct(n, !!opts.onlineStorePublicationId));
}

export async function getProduct(client: ShopifyAdminClient, productId: string, opts: { onlineStorePublicationId?: string | null } = {}): Promise<ShopifyProductSummary | null> {
  const data = await client.query("product", PRODUCT_QUERY, { id: productGid(productId), ...pubVars(opts.onlineStorePublicationId ?? null) }, productByIdSchema);
  return data.product ? mapProduct(data.product, !!opts.onlineStorePublicationId) : null;
}

/** Look a product up by one of its VARIANT ids — the canonical binding identity. */
export async function getProductByVariantId(client: ShopifyAdminClient, variantId: string, opts: { onlineStorePublicationId?: string | null } = {}): Promise<ShopifyProductSummary | null> {
  const data = await client.query("variantProduct", VARIANT_QUERY, { id: variantGid(variantId), ...pubVars(opts.onlineStorePublicationId ?? null) }, variantProductSchema);
  return data.productVariant ? mapProduct(data.productVariant.product, !!opts.onlineStorePublicationId) : null;
}

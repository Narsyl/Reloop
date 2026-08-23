/**
 * Products — search/read (for discovery, duplicate detection and verification) and the ONE write flow
 * this connector exists for: create a fulfilment-marker product in the target state
 * (title, SKU, price 0.00, UNLISTED, untracked inventory, published to the Online Store, classified
 * by product type + tag). No other product mutation is exposed.
 */
import { assertNoUserErrors, productGid, variantGid, type ShopifyAdminClient } from "./client";
import { ShopifyError } from "./errors";
import { mapProduct } from "./mapper";
import { productByIdSchema, productCreateSchema, productUpdateSchema, productsSearchSchema, variantProductSchema, variantsBulkUpdateSchema } from "./schemas";
import { publishProduct } from "./publications";
import type { MarkerProductSpec, ShopifyProductStatus, ShopifyProductSummary } from "./types";

const PRODUCT_FIELDS = `
  id title handle status productType tags vendor onlineStoreUrl updatedAt
  publishedOnPublication(publicationId: $publicationId) @include(if: $withPublication)
  variants(first: 25) { nodes { id title sku price inventoryItem { id tracked requiresShipping } } }
`;
const SEARCH_QUERY = `query SubscriptionOpsSearchProducts($query: String!, $first: Int!, $publicationId: ID!, $withPublication: Boolean!) { products(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) { nodes { ${PRODUCT_FIELDS} } } }`;
const PRODUCT_QUERY = `query SubscriptionOpsProduct($id: ID!, $publicationId: ID!, $withPublication: Boolean!) { product(id: $id) { ${PRODUCT_FIELDS} } }`;
const VARIANT_QUERY = `query SubscriptionOpsVariant($id: ID!, $publicationId: ID!, $withPublication: Boolean!) { productVariant(id: $id) { id product { ${PRODUCT_FIELDS} } } }`;
const CREATE_MUTATION = `mutation productCreate($product: ProductCreateInput!) { productCreate(product: $product) { product { id variants(first: 1) { nodes { id } } } userErrors { field message } } }`;
const UPDATE_MUTATION = `mutation productUpdate($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id } userErrors { field message } } }`;
const VARIANTS_MUTATION = `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id sku price } userErrors { field message } } }`;

// Shopify requires a non-null ID variable even when @include skips the field; use a harmless placeholder.
const NO_PUBLICATION = "gid://shopify/Publication/0";
const pubVars = (publicationId: string | null) => ({ publicationId: publicationId ?? NO_PUBLICATION, withPublication: !!publicationId });

/** Escape a value for Shopify's search query syntax (quoted, backslash/quote escaped). */
export function quoteSearchValue(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export async function searchProducts(client: ShopifyAdminClient, query: string, opts: { first?: number; onlineStorePublicationId?: string | null } = {}): Promise<ShopifyProductSummary[]> {
  const data = await client.query("searchProducts", SEARCH_QUERY, { query, first: opts.first ?? 10, ...pubVars(opts.onlineStorePublicationId ?? null) }, productsSearchSchema);
  return data.products.nodes.map((n) => mapProduct(n, !!opts.onlineStorePublicationId));
}

export async function getProduct(client: ShopifyAdminClient, productId: string, opts: { onlineStorePublicationId?: string | null } = {}): Promise<ShopifyProductSummary | null> {
  const data = await client.query("product", PRODUCT_QUERY, { id: productGid(productId), ...pubVars(opts.onlineStorePublicationId ?? null) }, productByIdSchema);
  return data.product ? mapProduct(data.product, !!opts.onlineStorePublicationId) : null;
}

/** Look a product up by one of its VARIANT ids — the canonical marker identity. */
export async function getProductByVariantId(client: ShopifyAdminClient, variantId: string, opts: { onlineStorePublicationId?: string | null } = {}): Promise<ShopifyProductSummary | null> {
  const data = await client.query("variantProduct", VARIANT_QUERY, { id: variantGid(variantId), ...pubVars(opts.onlineStorePublicationId ?? null) }, variantProductSchema);
  return data.productVariant ? mapProduct(data.productVariant.product, !!opts.onlineStorePublicationId) : null;
}

/**
 * Create a fulfilment-marker product in the target state. Three mutations, each allowlisted:
 *   productCreate (title, status, type, tags, description) → default variant id
 *   productVariantsBulkUpdate (price, inventoryItem { sku, tracked:false, requiresShipping:true }, taxable:false)
 *   publishablePublish (Online Store) when requested
 * Returns the product as re-read from Shopify (so callers store what Shopify says, not what we sent).
 */
export async function createMarkerProduct(client: ShopifyAdminClient, spec: MarkerProductSpec, onlineStorePublicationId: string | null): Promise<ShopifyProductSummary> {
  if (spec.publishToOnlineStore && !onlineStorePublicationId) throw new ShopifyError("VALIDATION_ERROR", "Online Store publication id is unknown; re-check the Shopify capabilities before creating markers.");
  const created = await client.mutate("productCreate", CREATE_MUTATION, {
    product: { title: spec.title, status: spec.status, productType: spec.productType, tags: spec.tags, descriptionHtml: spec.descriptionHtml ?? "", ...(spec.vendor ? { vendor: spec.vendor } : {}) },
  }, productCreateSchema);
  assertNoUserErrors("productCreate", created.productCreate.userErrors);
  const product = created.productCreate.product;
  if (!product) throw new ShopifyError("SCHEMA_ERROR", "productCreate returned no product");
  const defaultVariantGid = product.variants.nodes[0]?.id;
  if (!defaultVariantGid) throw new ShopifyError("SCHEMA_ERROR", "productCreate returned a product without a default variant");
  const updated = await client.mutate("productVariantsBulkUpdate", VARIANTS_MUTATION, {
    productId: product.id,
    variants: [{ id: defaultVariantGid, price: spec.price, taxable: false, inventoryPolicy: "CONTINUE", inventoryItem: { sku: spec.sku, tracked: false, requiresShipping: true } }],
  }, variantsBulkUpdateSchema);
  assertNoUserErrors("productVariantsBulkUpdate", updated.productVariantsBulkUpdate.userErrors);
  if (spec.publishToOnlineStore && onlineStorePublicationId) await publishProduct(client, product.id, onlineStorePublicationId);
  const reread = await getProduct(client, product.id, { onlineStorePublicationId });
  if (!reread) throw new ShopifyError("NOT_FOUND", "Created marker product could not be re-read");
  return reread;
}

/** Explicit, operator-requested update of a marker product's presentation/state. */
export async function updateMarkerProduct(
  client: ShopifyAdminClient,
  productId: string,
  variantId: string,
  changes: { title?: string; status?: ShopifyProductStatus; sku?: string; price?: string; tags?: string[]; productType?: string },
  onlineStorePublicationId: string | null,
): Promise<ShopifyProductSummary> {
  if (changes.title !== undefined || changes.status !== undefined || changes.tags !== undefined || changes.productType !== undefined) {
    const data = await client.mutate("productUpdate", UPDATE_MUTATION, { product: { id: productGid(productId), ...(changes.title !== undefined ? { title: changes.title } : {}), ...(changes.status !== undefined ? { status: changes.status } : {}), ...(changes.tags !== undefined ? { tags: changes.tags } : {}), ...(changes.productType !== undefined ? { productType: changes.productType } : {}) } }, productUpdateSchema);
    assertNoUserErrors("productUpdate", data.productUpdate.userErrors);
  }
  if (changes.sku !== undefined || changes.price !== undefined) {
    const data = await client.mutate("productVariantsBulkUpdate", VARIANTS_MUTATION, { productId: productGid(productId), variants: [{ id: variantGid(variantId), ...(changes.price !== undefined ? { price: changes.price } : {}), ...(changes.sku !== undefined ? { inventoryItem: { sku: changes.sku } } : {}) }] }, variantsBulkUpdateSchema);
    assertNoUserErrors("productVariantsBulkUpdate", data.productVariantsBulkUpdate.userErrors);
  }
  const reread = await getProduct(client, productId, { onlineStorePublicationId });
  if (!reread) throw new ShopifyError("NOT_FOUND", "Marker product could not be re-read after update");
  return reread;
}

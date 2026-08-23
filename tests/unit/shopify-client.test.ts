import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ShopifyAdminClient, SHOPIFY_API_VERSION, MUTATION_ALLOWLIST, normalizeShopDomain, ShopifyError, createShopifyConnector, REQUIRED_SHOPIFY_SCOPES, MARKER_TAG, MARKER_PRODUCT_TYPE } from "@/lib/integrations/shopify";
import { assertNoUserErrors, gidToId, productGid, variantGid } from "@/lib/integrations/shopify/client";
import { markerIssues } from "@/lib/domain/markers/shopify";
import type { Logger } from "@/lib/logging/logger";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent } as unknown as Logger;
const creds = { shopDomain: "ancient-extracts.myshopify.com", accessToken: "shpat_test_token_1234567890" };

type FetchCall = { url: string; body: { query: string; variables: Record<string, unknown> }; headers: Record<string, string> };

/** Build a fetch mock that answers each call from a queue (or a router function). */
function fetchQueue(responses: Array<{ status?: number; json?: unknown; headers?: Record<string, string>; text?: string } | ((call: FetchCall) => { status?: number; json?: unknown; headers?: Record<string, string> })>) {
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as FetchCall["body"];
    const call = { url: String(url), body, headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error("no fetch response queued");
    const r = typeof next === "function" ? next(call) : next;
    const status = r.status ?? 200;
    const headers = new Headers(r.headers ?? {});
    const text: string = "text" in r && typeof r.text === "string" ? r.text : JSON.stringify(r.json ?? {});
    return new Response(text, { status, headers });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function client(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof ShopifyAdminClient>[0]> = {}) {
  return new ShopifyAdminClient({ credentials: creds, fetchImpl, log: silent, maxRetries: 1, ...extra });
}

describe("Shopify admin client — transport", () => {
  it("posts to the versioned GraphQL endpoint with the token header, never logging it", async () => {
    const q = fetchQueue([{ json: { data: { shop: { id: "gid://shopify/Shop/1", name: "AE", myshopifyDomain: "ancient-extracts.myshopify.com", currencyCode: "GBP" } } } }]);
    const c = client(q.impl);
    const data = await c.query("shop", "query { shop { id } }", {}, z.object({ shop: z.object({ name: z.string() }) }));
    expect(data.shop.name).toBe("AE");
    expect(q.calls[0].url).toBe(`https://ancient-extracts.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);
    expect(q.calls[0].headers["X-Shopify-Access-Token"]).toBe(creds.accessToken);
    expect(c.endpoint).toContain(SHOPIFY_API_VERSION);
  });
  it("normalises shop domains and rejects non-myshopify hosts", () => {
    expect(normalizeShopDomain(" https://Ancient-Extracts.myshopify.com/admin ")).toBe("ancient-extracts.myshopify.com");
    expect(() => normalizeShopDomain("ancientextracts.co.uk")).toThrow(ShopifyError);
    expect(() => new ShopifyAdminClient({ credentials: { shopDomain: creds.shopDomain, accessToken: "" }, fetchImpl: fetch, log: silent })).toThrow(/token is missing/);
  });
  it("401 → AUTHENTICATION_ERROR, 403 → PERMISSION_ERROR, 404 → NOT_FOUND (no retry)", async () => {
    for (const [status, kind] of [[401, "AUTHENTICATION_ERROR"], [403, "PERMISSION_ERROR"], [404, "NOT_FOUND"]] as const) {
      const q = fetchQueue([{ status, json: { errors: "x" } }]);
      await expect(client(q.impl).query("shop", "query { shop { id } }")).rejects.toMatchObject({ kind });
      expect(q.calls).toHaveLength(1);
    }
  });
  it("retries 429 / 5xx then surfaces RATE_LIMITED / REMOTE_SERVER_ERROR", async () => {
    const q = fetchQueue([{ status: 429, headers: { "retry-after": "0" } }, { status: 429, headers: { "retry-after": "0" } }]);
    await expect(client(q.impl, { maxRetries: 1 }).query("shop", "query { shop { id } }")).rejects.toMatchObject({ kind: "RATE_LIMITED" });
    expect(q.calls).toHaveLength(2);
    const q2 = fetchQueue([{ status: 503 }, { json: { data: { ok: true } } }]);
    await expect(client(q2.impl, { maxRetries: 1 }).query("shop", "query { shop { id } }")).resolves.toEqual({ ok: true });
  }, 20_000);
  it("GraphQL errors: THROTTLED retries; ACCESS_DENIED → PERMISSION_ERROR; other → VALIDATION_ERROR", async () => {
    const q = fetchQueue([{ json: { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] } }, { json: { data: { ok: 1 } } }]);
    await expect(client(q.impl).query("x", "query { x }")).resolves.toEqual({ ok: 1 });
    const q2 = fetchQueue([{ json: { errors: [{ message: "Access denied for products field. Required access: `read_products` access scope.", extensions: { code: "ACCESS_DENIED" } }] } }]);
    await expect(client(q2.impl).query("x", "query { x }")).rejects.toMatchObject({ kind: "PERMISSION_ERROR" });
    const q3 = fetchQueue([{ json: { errors: [{ message: "Field 'foo' doesn't exist" }] } }]);
    await expect(client(q3.impl).query("x", "query { x }")).rejects.toMatchObject({ kind: "VALIDATION_ERROR" });
  }, 20_000);
  it("validates responses with the provided schema → SCHEMA_ERROR on contract drift; non-JSON → SCHEMA_ERROR", async () => {
    const q = fetchQueue([{ json: { data: { shop: { nope: true } } } }]);
    await expect(client(q.impl).query("shop", "query { shop { id } }", {}, z.object({ shop: z.object({ name: z.string() }) }))).rejects.toMatchObject({ kind: "SCHEMA_ERROR" });
    const q2 = fetchQueue([{ text: "<html>maintenance</html>" }]);
    await expect(client(q2.impl).query("shop", "query { shop { id } }")).rejects.toMatchObject({ kind: "SCHEMA_ERROR" });
  });
  it("waits on the cost-based throttle status before the next request (bounded)", async () => {
    const q = fetchQueue([{ json: { data: { a: 1 }, extensions: { cost: { actualQueryCost: 10, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 150, restoreRate: 100 } } } } }, { json: { data: { b: 2 } } }]);
    const c = client(q.impl);
    await c.query("a", "query { a }");
    const t0 = Date.now();
    await c.query("b", "query { b }");
    // needed 50 points at 100/s → ~500ms wait
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
  });
});

describe("Shopify admin client — mutation allowlist (least privilege)", () => {
  it("only product/variant/publication mutations are allowlisted", () => {
    expect([...MUTATION_ALLOWLIST].sort()).toEqual(["productCreate", "productUpdate", "productVariantsBulkUpdate", "publishablePublish", "publishableUnpublish"]);
  });
  it("refuses any non-allowlisted mutation client-side, before any network call", async () => {
    const q = fetchQueue([]);
    const c = client(q.impl);
    for (const op of ["orderEditBegin", "orderUpdate", "customerUpdate", "draftOrderCreate", "fulfillmentCreateV2", "inventoryAdjustQuantities", "subscriptionContractCreate", "discountCodeBasicCreate"]) {
      await expect(c.mutate(op, `mutation { ${op}(input: {}) { userErrors { message } } }`)).rejects.toMatchObject({ kind: "FORBIDDEN_OPERATION" });
    }
    expect(q.calls).toHaveLength(0);
  });
  it("refuses an allowlisted operation name whose document smuggles a forbidden field", async () => {
    const q = fetchQueue([]);
    const doc = `mutation productUpdate($product: ProductUpdateInput!) {\n  productUpdate(product: $product) { product { id } }\n  orderUpdate(input: { id: "gid://shopify/Order/1" }) { userErrors { message } }\n}`;
    await expect(client(q.impl).mutate("productUpdate", doc, {})).rejects.toMatchObject({ kind: "FORBIDDEN_OPERATION" });
    expect(q.calls).toHaveLength(0);
  });
  it("userErrors → USER_ERROR with field paths", () => {
    expect(() => assertNoUserErrors("productCreate", [{ field: ["product", "title"], message: "can't be blank" }])).toThrow(/product\.title: can't be blank/);
    expect(() => assertNoUserErrors("productCreate", [])).not.toThrow();
  });
  it("GID helpers", () => {
    expect(gidToId("gid://shopify/ProductVariant/56259577545090")).toBe("56259577545090");
    expect(gidToId("gid://shopify/Product/123?x=1")).toBe("123");
    expect(() => gidToId("nope")).toThrow(ShopifyError);
    expect(productGid("9")).toBe("gid://shopify/Product/9");
    expect(variantGid("gid://shopify/ProductVariant/9")).toBe("gid://shopify/ProductVariant/9");
  });
});

const shopPayload = { shop: { id: "gid://shopify/Shop/1", name: "Ancient Extracts", myshopifyDomain: "ancient-extracts.myshopify.com", primaryDomain: { host: "ancientextracts.co.uk" }, currencyCode: "GBP", plan: { displayName: "Shopify" }, ianaTimezone: "Europe/London" } };
const scopesPayload = (handles: string[]) => ({ currentAppInstallation: { accessScopes: handles.map((handle) => ({ handle })) } });
const publicationsPayload = { publications: { nodes: [{ id: "gid://shopify/Publication/111", name: "Online Store", catalog: null }, { id: "gid://shopify/Publication/222", name: "Point of Sale", catalog: null }] } };
const productNode = (over: Record<string, unknown> = {}) => ({
  id: "gid://shopify/Product/7001",
  title: "Morning Magic 2",
  handle: "morning-magic-2",
  status: "UNLISTED",
  productType: MARKER_PRODUCT_TYPE,
  tags: [MARKER_TAG, "reward:cup"],
  vendor: "Ancient Extracts",
  onlineStoreUrl: null,
  updatedAt: "2026-08-23T20:00:00Z",
  publishedOnPublication: true,
  variants: { nodes: [{ id: "gid://shopify/ProductVariant/8001", title: "Default Title", sku: "MM-CYCLE-02", price: "0.00", inventoryItem: { id: "gid://shopify/InventoryItem/9001", tracked: false, requiresShipping: true } }] },
  ...over,
});

/** Router that answers by operation name found in the query document. */
function routeByOperation(handlers: Record<string, (vars: Record<string, unknown>, call: FetchCall) => unknown>, log: string[] = []) {
  return (call: FetchCall) => {
    const m = /^\s*(query|mutation)\s+([A-Za-z]+)/.exec(call.body.query);
    const op = m?.[2] ?? "?";
    log.push(op);
    const h = handlers[op];
    if (!h) return { status: 500, json: { errors: [{ message: `unhandled op ${op}` }] } };
    return { json: { data: h(call.body.variables, call) } };
  };
}

describe("Shopify connector — capability report and marker creation (mocked API)", () => {
  it("probeCapabilities: least-privilege report, Online Store publication discovered, extra scopes flagged", async () => {
    const ops: string[] = [];
    const router = routeByOperation({
      SubscriptionOpsShop: () => shopPayload,
      SubscriptionOpsScopes: () => scopesPayload([...REQUIRED_SHOPIFY_SCOPES, "read_orders"]),
      SubscriptionOpsProductsProbe: () => ({ products: { nodes: [] } }),
      SubscriptionOpsPublications: () => publicationsPayload,
    }, ops);
    const q = fetchQueue([router, router, router, router]);
    const report = await createShopifyConnector(client(q.impl)).probeCapabilities();
    expect(report.store.myshopifyDomain).toBe("ancient-extracts.myshopify.com");
    expect(report.storeIdentity).toBe("available");
    expect(report.productsRead).toBe("available");
    expect(report.productsWrite).toBe("available");
    expect(report.publicationsRead).toBe("available");
    expect(report.publicationsWrite).toBe("available");
    expect(report.onlineStorePublicationId).toBe("gid://shopify/Publication/111");
    expect(report.requiredOk).toBe(true);
    expect(report.missingScopes).toEqual([]);
    expect(report.unexpectedScopes).toEqual(["read_orders"]);
    expect(report.notRequested).toEqual(expect.arrayContaining(["orders", "customers", "fulfillments"]));
    // no mutation was sent by the probe
    expect(ops.every((o) => o.startsWith("SubscriptionOps"))).toBe(true);
  });
  it("probeCapabilities: missing write_publications → requiredOk=false with the scope named", async () => {
    const router = routeByOperation({
      SubscriptionOpsShop: () => shopPayload,
      SubscriptionOpsScopes: () => scopesPayload(["read_products", "write_products", "read_publications"]),
      SubscriptionOpsProductsProbe: () => ({ products: { nodes: [] } }),
      SubscriptionOpsPublications: () => publicationsPayload,
    });
    const q = fetchQueue([router, router, router, router]);
    const report = await createShopifyConnector(client(q.impl)).probeCapabilities();
    expect(report.requiredOk).toBe(false);
    expect(report.missingScopes).toEqual(["write_publications"]);
    expect(report.publicationsWrite).toBe("unavailable");
  });
  it("createMarkerProduct: productCreate → productVariantsBulkUpdate (0.00, untracked, SKU, taxable false) → publishablePublish → re-read", async () => {
    const ops: string[] = [];
    const sent: Record<string, unknown>[] = [];
    const router = routeByOperation({
      productCreate: (v) => { sent.push(v); return { productCreate: { product: { id: "gid://shopify/Product/7001", variants: { nodes: [{ id: "gid://shopify/ProductVariant/8001" }] } }, userErrors: [] } }; },
      productVariantsBulkUpdate: (v) => { sent.push(v); return { productVariantsBulkUpdate: { productVariants: [{ id: "gid://shopify/ProductVariant/8001", sku: "MM-CYCLE-02", price: "0.00" }], userErrors: [] } }; },
      publishablePublish: (v) => { sent.push(v); return { publishablePublish: { userErrors: [] } }; },
      SubscriptionOpsProduct: (v) => { sent.push(v); return { product: productNode() }; },
    }, ops);
    const q = fetchQueue([router, router, router, router]);
    const connector = createShopifyConnector(client(q.impl), { onlineStorePublicationId: "gid://shopify/Publication/111" });
    const product = await connector.createMarkerProduct({ title: "Morning Magic 2", sku: "MM-CYCLE-02", price: "0.00", status: "UNLISTED", productType: MARKER_PRODUCT_TYPE, tags: [MARKER_TAG, "reward:cup"], descriptionHtml: "<p>Include cup</p>", publishToOnlineStore: true });
    expect(ops).toEqual(["productCreate", "productVariantsBulkUpdate", "publishablePublish", "SubscriptionOpsProduct"]);
    expect(sent[0]).toMatchObject({ product: { title: "Morning Magic 2", status: "UNLISTED", productType: MARKER_PRODUCT_TYPE, tags: [MARKER_TAG, "reward:cup"] } });
    expect(sent[1]).toMatchObject({ productId: "gid://shopify/Product/7001", variants: [{ id: "gid://shopify/ProductVariant/8001", price: "0.00", taxable: false, inventoryPolicy: "CONTINUE", inventoryItem: { sku: "MM-CYCLE-02", tracked: false, requiresShipping: true } }] });
    expect(sent[2]).toMatchObject({ id: "gid://shopify/Product/7001", input: [{ publicationId: "gid://shopify/Publication/111" }] });
    expect(sent[3]).toMatchObject({ id: "gid://shopify/Product/7001", publicationId: "gid://shopify/Publication/111", withPublication: true });
    // canonical identity = numeric variant id; product reflects what Shopify says (re-read)
    expect(product.productId).toBe("7001");
    expect(product.variants[0].variantId).toBe("8001");
    expect(product.variants[0].sku).toBe("MM-CYCLE-02");
    expect(product.variants[0].price).toBe("0.00");
    expect(product.variants[0].inventoryTracked).toBe(false);
    expect(product.status).toBe("UNLISTED");
    expect(product.publishedOnlineStore).toBe(true);
  });
  it("createMarkerProduct refuses when the Online Store publication is unknown and publish is requested (no mutation sent)", async () => {
    const q = fetchQueue([]);
    const connector = createShopifyConnector(client(q.impl), { onlineStorePublicationId: null });
    await expect(connector.createMarkerProduct({ title: "X 2", sku: "X-CYCLE-02", price: "0.00", status: "UNLISTED", productType: MARKER_PRODUCT_TYPE, tags: [MARKER_TAG], publishToOnlineStore: true })).rejects.toMatchObject({ kind: "VALIDATION_ERROR" });
    expect(q.calls).toHaveLength(0);
  });
  it("createMarkerProduct surfaces userErrors from productCreate as USER_ERROR and stops", async () => {
    const ops: string[] = [];
    const router = routeByOperation({ productCreate: () => ({ productCreate: { product: null, userErrors: [{ field: ["product", "title"], message: "has already been taken" }] } }) }, ops);
    const q = fetchQueue([router]);
    const connector = createShopifyConnector(client(q.impl), { onlineStorePublicationId: "gid://shopify/Publication/111" });
    await expect(connector.createMarkerProduct({ title: "Morning Magic 2", sku: "MM-CYCLE-02", price: "0.00", status: "UNLISTED", productType: MARKER_PRODUCT_TYPE, tags: [MARKER_TAG], publishToOnlineStore: true })).rejects.toMatchObject({ kind: "USER_ERROR" });
    expect(ops).toEqual(["productCreate"]);
  });
  it("search by SKU / title quotes the value and maps variants; lookup by variant id returns the product", async () => {
    const seen: Record<string, unknown>[] = [];
    const router = routeByOperation({
      SubscriptionOpsSearchProducts: (v) => { seen.push(v); return { products: { nodes: [productNode()] } }; },
      SubscriptionOpsVariant: (v) => { seen.push(v); return { productVariant: { id: "gid://shopify/ProductVariant/8001", product: productNode() } }; },
    });
    const q = fetchQueue([router, router, router]);
    const connector = createShopifyConnector(client(q.impl), { onlineStorePublicationId: "gid://shopify/Publication/111" });
    const bySku = await connector.searchBySku('MM-CYCLE-02');
    expect(seen[0]).toMatchObject({ query: 'sku:"MM-CYCLE-02"', first: 10 });
    expect(bySku[0].variants[0].variantId).toBe("8001");
    await connector.searchByTitle('Morning "Magic" 2');
    expect(seen[1]).toMatchObject({ query: 'title:"Morning \\"Magic\\" 2"' });
    const byVariant = await connector.getProductByVariantId("8001");
    expect(seen[2]).toMatchObject({ id: "gid://shopify/ProductVariant/8001" });
    expect(byVariant?.productId).toBe("7001");
    expect(byVariant?.publishedOnlineStore).toBe(true);
  });
});

describe("marker verification rules", () => {
  const variant = { sku: "MM-CYCLE-02", price: "0.00", inventoryTracked: false };
  const base = { productId: "7001", productGid: "gid://shopify/Product/7001", title: "Morning Magic 2", handle: "morning-magic-2", status: "UNLISTED" as const, productType: MARKER_PRODUCT_TYPE, tags: [MARKER_TAG], vendor: null, onlineStoreUrl: null, publishedOnlineStore: true, variants: [], updatedAt: null };
  it("target state → no issues", () => {
    expect(markerIssues(base, variant, { expectedSku: "MM-CYCLE-02", expectedTitle: "Morning Magic 2" })).toEqual([]);
  });
  it("flags ACTIVE (customer-visible), DRAFT, unpublished, priced, tracked, mismatches, missing tag", () => {
    expect(markerIssues({ ...base, status: "ACTIVE" }, variant, { expectedSku: null, expectedTitle: null })).toEqual(["VISIBLE_TO_CUSTOMERS"]);
    expect(markerIssues({ ...base, status: "DRAFT" }, variant, { expectedSku: null, expectedTitle: null })).toEqual(["DRAFT_OR_ARCHIVED"]);
    expect(markerIssues({ ...base, publishedOnlineStore: false }, variant, { expectedSku: null, expectedTitle: null })).toEqual(["NOT_PUBLISHED_ONLINE_STORE"]);
    expect(markerIssues(base, { ...variant, price: "1.00", inventoryTracked: true }, { expectedSku: "MM-CYCLE-02", expectedTitle: null })).toEqual(["PRICE_NOT_ZERO", "INVENTORY_TRACKED"]);
    expect(markerIssues(base, { ...variant, sku: "OLD" }, { expectedSku: "MM-CYCLE-02", expectedTitle: "Morning Magic Cup" })).toEqual(["SKU_MISMATCH", "TITLE_MISMATCH"]);
    expect(markerIssues({ ...base, tags: [], productType: "Powder" }, variant, { expectedSku: null, expectedTitle: null })).toEqual(["MISSING_MARKER_TAG"]);
    expect(markerIssues(null, null, { expectedSku: null, expectedTitle: null })).toEqual(["MISSING_IN_SHOPIFY"]);
  });
});

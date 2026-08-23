import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ShopifyAdminClient,
  SHOPIFY_API_VERSION,
  normalizeShopDomain,
  ShopifyError,
  createShopifyConnector,
  createTokenProvider,
  ClientCredentialsTokenProvider,
  StaticTokenProvider,
  exchangeClientCredentials,
  isMutationDocument,
  buildSearchQuery,
  gidToId,
  REQUIRED_SHOPIFY_SCOPES,
  type ShopifyTokenCacheStore,
} from "@/lib/integrations/shopify";
import { productGid, variantGid } from "@/lib/integrations/shopify/client";
import type { Logger } from "@/lib/logging/logger";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent } as unknown as Logger;
const SHOP = "ancient-extracts.myshopify.com";
const CREDS = { shopDomain: SHOP, clientId: "client_id_123456", clientSecret: "client_secret_abcdef" };

type FetchCall = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

function fetchQueue(responses: Array<{ status?: number; json?: unknown; headers?: Record<string, string>; text?: string } | ((call: FetchCall) => { status?: number; json?: unknown; headers?: Record<string, string> })>) {
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const call = { url: String(url), body, headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error("no fetch response queued");
    const r = typeof next === "function" ? next(call) : next;
    const text: string = "text" in r && typeof r.text === "string" ? r.text : JSON.stringify(r.json ?? {});
    return new Response(text, { status: r.status ?? 200, headers: new Headers(r.headers ?? {}) });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const tokenResponse = (token = "shpat_ephemeral_1", expiresIn = 86_399) => ({ json: { access_token: token, scope: "read_products,read_publications", expires_in: expiresIn } });

function memoryCache(initial: { accessToken: string; expiresAt: Date | null; scope: string[] } | null = null): ShopifyTokenCacheStore & { saved: { accessToken: string; expiresAt: Date | null }[] } {
  let stored = initial;
  const saved: { accessToken: string; expiresAt: Date | null }[] = [];
  return {
    saved,
    async load() {
      return stored;
    },
    async save(t) {
      stored = { accessToken: t.accessToken, expiresAt: t.expiresAt, scope: t.scope };
      saved.push({ accessToken: t.accessToken, expiresAt: t.expiresAt });
    },
    async clear() {
      stored = null;
    },
  };
}

describe("client-credentials token exchange", () => {
  it("POSTs client_id/client_secret/grant_type to /admin/oauth/access_token and computes the expiry", async () => {
    const q = fetchQueue([tokenResponse("shpat_x", 86_399)]);
    const now = new Date("2026-08-23T20:00:00Z");
    const t = await exchangeClientCredentials(CREDS, { fetchImpl: q.impl, now: () => now, log: silent });
    expect(q.calls[0].url).toBe(`https://${SHOP}/admin/oauth/access_token`);
    expect(q.calls[0].body).toEqual({ client_id: CREDS.clientId, client_secret: CREDS.clientSecret, grant_type: "client_credentials" });
    expect(t.accessToken).toBe("shpat_x");
    expect(t.scope).toEqual(["read_products", "read_publications"]);
    expect(t.expiresAt?.toISOString()).toBe(new Date(now.getTime() + 86_399_000).toISOString());
  });
  it("bad credentials → AUTHENTICATION_ERROR with Shopify's description; unknown shop → NOT_FOUND; missing creds refused locally", async () => {
    const q = fetchQueue([{ status: 401, json: { error: "invalid_client", error_description: "Client authentication failed" } }]);
    await expect(exchangeClientCredentials(CREDS, { fetchImpl: q.impl, log: silent })).rejects.toMatchObject({ kind: "AUTHENTICATION_ERROR", message: expect.stringContaining("Client authentication failed") });
    const q2 = fetchQueue([{ status: 404, text: "Not found" }]);
    await expect(exchangeClientCredentials(CREDS, { fetchImpl: q2.impl, log: silent })).rejects.toMatchObject({ kind: "NOT_FOUND" });
    await expect(exchangeClientCredentials({ ...CREDS, clientSecret: " " }, { fetchImpl: fetchQueue([]).impl, log: silent })).rejects.toMatchObject({ kind: "AUTHENTICATION_ERROR" });
    expect(() => normalizeShopDomain("ancientextracts.co.uk")).toThrow(ShopifyError);
  });
  it("caches the token (memo + store), reuses it while valid, refreshes near expiry, and de-duplicates concurrent exchanges", async () => {
    let nowMs = Date.parse("2026-08-23T20:00:00Z");
    const now = () => new Date(nowMs);
    const cache = memoryCache();
    const q = fetchQueue([tokenResponse("shpat_1", 3600), tokenResponse("shpat_2", 3600)]);
    const p = new ClientCredentialsTokenProvider(CREDS, { cache, fetchImpl: q.impl, now, log: silent });
    const [a, b, c] = await Promise.all([p.getAccessToken(), p.getAccessToken(), p.getAccessToken()]);
    expect([a, b, c]).toEqual(["shpat_1", "shpat_1", "shpat_1"]);
    expect(q.calls).toHaveLength(1); // concurrent calls share one exchange
    expect(cache.saved).toHaveLength(1);
    nowMs += 30 * 60_000; // 30 min later: still comfortably valid
    expect(await p.getAccessToken()).toBe("shpat_1");
    expect(q.calls).toHaveLength(1);
    nowMs += 26 * 60_000; // 56 min: inside the 5-minute refresh margin
    expect(await p.getAccessToken()).toBe("shpat_2");
    expect(q.calls).toHaveLength(2);
    expect(p.describe()).toMatchObject({ authMode: "CLIENT_CREDENTIALS", cached: true });
  });
  it("a second process picks the token up from the shared cache without exchanging", async () => {
    const cache = memoryCache({ accessToken: "shpat_shared", expiresAt: new Date(Date.now() + 3_600_000), scope: [] });
    const q = fetchQueue([]);
    const p = new ClientCredentialsTokenProvider(CREDS, { cache, fetchImpl: q.impl, log: silent });
    expect(await p.getAccessToken()).toBe("shpat_shared");
    expect(q.calls).toHaveLength(0);
  });
  it("createTokenProvider: ACCESS_TOKEN mode is static (tests / future merchant OAuth)", async () => {
    const p = createTokenProvider({ authMode: "ACCESS_TOKEN", shopDomain: SHOP, accessToken: "shpat_static" });
    expect(p).toBeInstanceOf(StaticTokenProvider);
    expect(await p.getAccessToken()).toBe("shpat_static");
  });
});

function client(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof ShopifyAdminClient>[0]> = {}) {
  return new ShopifyAdminClient({ shopDomain: SHOP, tokenProvider: new StaticTokenProvider("shpat_static"), fetchImpl, log: silent, maxRetries: 1, ...extra });
}

describe("Shopify admin client — READ-ONLY transport", () => {
  it("posts to the versioned GraphQL endpoint with the token header (token never logged)", async () => {
    const q = fetchQueue([{ json: { data: { shop: { name: "AE" } } } }]);
    const c = client(q.impl);
    const data = await c.query("shop", "query { shop { name } }", {}, z.object({ shop: z.object({ name: z.string() }) }));
    expect(data.shop.name).toBe("AE");
    expect(q.calls[0].url).toBe(`https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);
    expect(q.calls[0].headers["X-Shopify-Access-Token"]).toBe("shpat_static");
  });
  it("REFUSES any mutation document before any network call — the connector has no write surface", async () => {
    const q = fetchQueue([]);
    const c = client(q.impl);
    for (const doc of [
      "mutation productCreate($p: ProductCreateInput!) { productCreate(product: $p) { product { id } } }",
      "  mutation { orderUpdate(input: {}) { userErrors { message } } }",
      "# comment\nmutation X { publishablePublish(id: \"1\", input: []) { userErrors { message } } }",
    ]) {
      await expect(c.query("op", doc)).rejects.toMatchObject({ kind: "FORBIDDEN_OPERATION" });
    }
    expect(q.calls).toHaveLength(0);
    expect(isMutationDocument("query Q { shop { id } }")).toBe(false);
    expect(isMutationDocument("mutation M { x }")).toBe(true);
  });
  it("401 with client credentials → one forced refresh and retry; static token → AUTHENTICATION_ERROR", async () => {
    const nowMs = Date.parse("2026-08-23T20:00:00Z");
    const q = fetchQueue([
      tokenResponse("shpat_old", 3600), // initial exchange
      { status: 401, json: { errors: "[API] Invalid API key or access token" } }, // GraphQL with stale token
      tokenResponse("shpat_new", 3600), // forced refresh
      (call) => ({ json: { data: { ok: call.headers["X-Shopify-Access-Token"] === "shpat_new" } } }),
    ]);
    const provider = new ClientCredentialsTokenProvider(CREDS, { fetchImpl: q.impl, now: () => new Date(nowMs), log: silent });
    const c = new ShopifyAdminClient({ shopDomain: SHOP, tokenProvider: provider, fetchImpl: q.impl, log: silent, maxRetries: 1 });
    await expect(c.query("shop", "query { shop { id } }")).resolves.toEqual({ ok: true });
    const q2 = fetchQueue([{ status: 401, json: {} }]);
    await expect(client(q2.impl).query("shop", "query { shop { id } }")).rejects.toMatchObject({ kind: "AUTHENTICATION_ERROR" });
  });
  it("403 → PERMISSION_ERROR; 404 → NOT_FOUND; retries 429/5xx; GraphQL ACCESS_DENIED → PERMISSION_ERROR; schema drift → SCHEMA_ERROR", async () => {
    for (const [status, kind] of [[403, "PERMISSION_ERROR"], [404, "NOT_FOUND"]] as const) {
      const q = fetchQueue([{ status, json: {} }]);
      await expect(client(q.impl).query("x", "query { x }")).rejects.toMatchObject({ kind });
    }
    const q3 = fetchQueue([{ status: 503 }, { json: { data: { ok: 1 } } }]);
    await expect(client(q3.impl).query("x", "query { x }")).resolves.toEqual({ ok: 1 });
    const q4 = fetchQueue([{ json: { errors: [{ message: "Access denied for products field. Required access: `read_products` access scope.", extensions: { code: "ACCESS_DENIED" } }] } }]);
    await expect(client(q4.impl).query("x", "query { x }")).rejects.toMatchObject({ kind: "PERMISSION_ERROR" });
    const q5 = fetchQueue([{ json: { data: { shop: { nope: 1 } } } }]);
    await expect(client(q5.impl).query("shop", "query { shop { id } }", {}, z.object({ shop: z.object({ name: z.string() }) }))).rejects.toMatchObject({ kind: "SCHEMA_ERROR" });
  }, 20_000);
  it("waits on the cost-based throttle status before the next request (bounded)", async () => {
    const q = fetchQueue([{ json: { data: { a: 1 }, extensions: { cost: { actualQueryCost: 10, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 150, restoreRate: 100 } } } } }, { json: { data: { b: 2 } } }]);
    const c = client(q.impl);
    await c.query("a", "query { a }");
    const t0 = Date.now();
    await c.query("b", "query { b }");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
  });
  it("GID helpers + search query building", () => {
    expect(gidToId("gid://shopify/ProductVariant/56259577545090")).toBe("56259577545090");
    expect(() => gidToId("nope")).toThrow(ShopifyError);
    expect(productGid("9")).toBe("gid://shopify/Product/9");
    expect(variantGid("gid://shopify/ProductVariant/9")).toBe("gid://shopify/ProductVariant/9");
    expect(buildSearchQuery("cup")).toBe("title:*cup* OR sku:*cup*");
    expect(buildSearchQuery('sku:CUP-1')).toBe("sku:CUP-1");
    expect(buildSearchQuery('cu"p*')).toBe("title:*cup* OR sku:*cup*");
  });
});

const shopPayload = { shop: { id: "gid://shopify/Shop/1", name: "Ancient Extracts", myshopifyDomain: SHOP, primaryDomain: { host: "ancientextracts.co.uk" }, currencyCode: "GBP", plan: { displayName: "Shopify" }, ianaTimezone: "Europe/London" } };
const scopesPayload = (handles: string[]) => ({ currentAppInstallation: { accessScopes: handles.map((handle) => ({ handle })) } });
const productNode = (over: Record<string, unknown> = {}) => ({
  id: "gid://shopify/Product/7001",
  title: "Ceramic Cup",
  handle: "ceramic-cup",
  status: "ACTIVE",
  productType: "Accessories",
  tags: [],
  vendor: "Ancient Extracts",
  onlineStoreUrl: "https://ancientextracts.co.uk/products/ceramic-cup",
  updatedAt: "2026-08-23T20:00:00Z",
  variants: { nodes: [{ id: "gid://shopify/ProductVariant/8001", title: "Default Title", sku: "CUP-1", price: "12.00", availableForSale: true, inventoryItem: { id: "gid://shopify/InventoryItem/9001", tracked: false, requiresShipping: true } }] },
  ...over,
});

function routeByOperation(handlers: Record<string, (vars: Record<string, unknown>, call: FetchCall) => unknown>, log: string[] = []) {
  return (call: FetchCall) => {
    const m = /^\s*(query|mutation)\s+([A-Za-z]+)/.exec(String(call.body.query ?? ""));
    const op = m?.[2] ?? "?";
    log.push(op);
    const h = handlers[op];
    if (!h) return { status: 500, json: { errors: [{ message: `unhandled op ${op}` }] } };
    return { json: { data: h((call.body.variables ?? {}) as Record<string, unknown>, call) } };
  };
}

describe("connector — capability report and read-only search (mocked API)", () => {
  it("read_products only → requiredOk, publications optional not-granted, write scopes flagged as unexpected", async () => {
    const router = routeByOperation({
      SubscriptionOpsShop: () => shopPayload,
      SubscriptionOpsScopes: () => scopesPayload(["read_products", "write_products", "read_orders"]),
      SubscriptionOpsProductsProbe: () => ({ products: { nodes: [] } }),
    });
    const q = fetchQueue([router, router, router]);
    const report = await createShopifyConnector(client(q.impl)).probeCapabilities();
    expect(report.requiredOk).toBe(true);
    expect(report.productsRead).toBe("available");
    expect(report.publicationsRead).toBe("not-granted");
    expect(report.onlineStorePublicationId).toBeNull();
    expect(report.missingScopes).toEqual([]);
    expect(report.unexpectedScopes.sort()).toEqual(["read_orders", "write_products"]);
    expect(report.notRequested).toEqual(expect.arrayContaining(["write_products", "write_publications", "orders", "customers", "fulfillments"]));
    expect([...REQUIRED_SHOPIFY_SCOPES]).toEqual(["read_products"]);
  });
  it("read_publications granted → Online Store publication discovered and used for the published hint", async () => {
    const ops: string[] = [];
    const router = routeByOperation({
      SubscriptionOpsShop: () => shopPayload,
      SubscriptionOpsScopes: () => scopesPayload(["read_products", "read_publications"]),
      SubscriptionOpsProductsProbe: () => ({ products: { nodes: [] } }),
      SubscriptionOpsPublications: () => ({ publications: { nodes: [{ id: "gid://shopify/Publication/111", name: "Online Store" }] } }),
    }, ops);
    const q = fetchQueue([router, router, router, router]);
    const report = await createShopifyConnector(client(q.impl)).probeCapabilities();
    expect(report.publicationsRead).toBe("available");
    expect(report.onlineStorePublicationId).toBe("gid://shopify/Publication/111");
    expect(ops.every((o) => o.startsWith("SubscriptionOps"))).toBe(true); // reads only
  });
  it("search maps variants (canonical numeric ids) and variant-id lookup returns the product", async () => {
    const seen: Record<string, unknown>[] = [];
    const router = routeByOperation({
      SubscriptionOpsSearchProducts: (v) => {
        seen.push(v);
        return { products: { nodes: [productNode()] } };
      },
      SubscriptionOpsVariant: (v) => {
        seen.push(v);
        return { productVariant: { id: "gid://shopify/ProductVariant/8001", product: productNode() } };
      },
    });
    const q = fetchQueue([router, router]);
    const connector = createShopifyConnector(client(q.impl), { onlineStorePublicationId: "gid://shopify/Publication/111" });
    const results = await connector.search("cup");
    expect(seen[0]).toMatchObject({ query: "title:*cup* OR sku:*cup*" });
    expect(results[0].productId).toBe("7001");
    expect(results[0].variants[0]).toMatchObject({ variantId: "8001", sku: "CUP-1", price: "12.00", inventoryTracked: false, requiresShipping: true });
    const byVariant = await connector.getProductByVariantId("8001");
    expect(seen[1]).toMatchObject({ id: "gid://shopify/ProductVariant/8001", withPublication: true });
    expect(byVariant?.publishedOnlineStore).toBe(false); // fake did not set publishedOnPublication → treated as not published
  });
});

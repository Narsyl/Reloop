/**
 * Revised Phase 4c — Shopify reward bindings, end to end against a fake Shopify (token endpoint +
 * Admin GraphQL via a global fetch stub) and the real database:
 *   - connect a SHOPIFY integration with CLIENT CREDENTIALS (server-side exchange; encrypted client
 *     id/secret; encrypted token cache reused across connectors; wrong secret / cross-org pairing refused)
 *   - read-only capability report (read_products required; nothing else)
 *   - search the catalogue, bind reward items to EXISTING variants, verify, rebind, unbind
 *   - DB guarantees: one variant per reward, one binding per reward per store, tenant triggers
 *   - the fake Shopify never receives a mutation
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { dbFor } from "@/lib/db/tenant";
import { connectShopifyIntegration, getShopifyConnectorForIntegration, recheckShopifyIntegration, testShopifyCredentials } from "@/lib/domain/integrations/shopify";
import { bindRewardItem, listRewardBindings, searchCatalog, unbindRewardItem, verifyRewardBinding } from "@/lib/domain/rewards/bindings";
import { resolveProgramRewards } from "@/lib/domain/rewards/resolver";
import { assignProgramSchedule, setRewardScheduleStatus, upsertMilestone, upsertRewardItem, upsertRewardSchedule } from "@/lib/domain/rewards/core";

const run = Math.random().toString(36).slice(2, 8);
const orgA = { id: `test_rbA_${run}`, slug: `test-rba-${run}`, name: "Bindings A" };
const orgB = { id: `test_rbB_${run}`, slug: `test-rbb-${run}`, name: "Bindings B" };
const A = { organizationId: orgA.id, userId: null };
const B = { organizationId: orgB.id, userId: null };
const SHOP = `ae-${run}.myshopify.com`;
const CLIENT_ID = `cid_${run}`;
const CLIENT_SECRET = `csecret_${run}`;

function ok<T>(r: { ok: true; data?: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.data as T;
}

// ── fake Shopify ───────────────────────────────────────────────────────────
type FakeProduct = { id: string; title: string; handle: string; status: string; variants: { id: string; sku: string | null; price: string; tracked: boolean; requiresShipping: boolean }[] };
const shopify = {
  products: new Map<string, FakeProduct>(),
  scopes: "read_products",
  tokenExchanges: 0,
  tokenSerial: 0,
  validTokens: new Set<string>(),
  gqlOps: [] as string[],
};
function addProduct(id: number, title: string, sku: string, price: string, opts: { status?: string; tracked?: boolean; requiresShipping?: boolean } = {}) {
  const gid = `gid://shopify/Product/${id}`;
  shopify.products.set(gid, { id: gid, title, handle: title.toLowerCase().replace(/\s+/g, "-"), status: opts.status ?? "ACTIVE", variants: [{ id: `gid://shopify/ProductVariant/${id + 1}`, sku, price, tracked: opts.tracked ?? false, requiresShipping: opts.requiresShipping ?? true }] });
  return { productId: String(id), variantId: String(id + 1) };
}
const node = (p: FakeProduct) => ({ id: p.id, title: p.title, handle: p.handle, status: p.status, productType: "", tags: [], vendor: "AE", onlineStoreUrl: null, updatedAt: "2026-08-23T20:00:00Z", variants: { nodes: p.variants.map((v) => ({ id: v.id, title: "Default Title", sku: v.sku, price: v.price, availableForSale: true, inventoryItem: { id: v.id.replace("ProductVariant", "InventoryItem"), tracked: v.tracked, requiresShipping: v.requiresShipping } })) } });
function handleGraphQL(query: string, vars: Record<string, unknown>): unknown {
  const op = /^\s*(query|mutation)\s+([A-Za-z]+)/.exec(query)?.[2] ?? "?";
  shopify.gqlOps.push(op);
  switch (op) {
    case "SubscriptionOpsShop":
      return { shop: { id: "gid://shopify/Shop/1", name: "Ancient Extracts (fake)", myshopifyDomain: SHOP, primaryDomain: { host: "ancientextracts.co.uk" }, currencyCode: "GBP", plan: { displayName: "Shopify" }, ianaTimezone: "Europe/London" } };
    case "SubscriptionOpsScopes":
      return { currentAppInstallation: { accessScopes: shopify.scopes.split(",").map((handle) => ({ handle })) } };
    case "SubscriptionOpsProductsProbe":
      return { products: { nodes: [] } };
    case "SubscriptionOpsSearchProducts": {
      const q = String(vars.query);
      const m = /title:\*(.+?)\* OR sku:\*(.+?)\*/.exec(q);
      const term = (m?.[1] ?? q.replace(/^[a-z_]+:/i, "").replace(/"/g, "")).toLowerCase();
      const nodes = [...shopify.products.values()].filter((p) => p.title.toLowerCase().includes(term) || p.variants.some((v) => (v.sku ?? "").toLowerCase().includes(term))).map(node);
      return { products: { nodes } };
    }
    case "SubscriptionOpsProduct":
      return { product: shopify.products.get(String(vars.id)) ? node(shopify.products.get(String(vars.id))!) : null };
    case "SubscriptionOpsVariant": {
      const p = [...shopify.products.values()].find((x) => x.variants.some((v) => v.id === vars.id));
      return { productVariant: p ? { id: vars.id, product: node(p) } : null };
    }
    default:
      throw new Error(`fake shopify: unhandled ${op}`);
  }
}
const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  if (u === `https://${SHOP}/admin/oauth/access_token`) {
    const body = JSON.parse(String(init?.body)) as { client_id: string; client_secret: string; grant_type: string };
    if (body.grant_type !== "client_credentials") return new Response(JSON.stringify({ error: "unsupported_grant_type" }), { status: 400 });
    if (body.client_id !== CLIENT_ID || body.client_secret !== CLIENT_SECRET) return new Response(JSON.stringify({ error: "invalid_client", error_description: "Client authentication failed" }), { status: 401 });
    shopify.tokenExchanges++;
    const token = `shpat_fake_${++shopify.tokenSerial}`;
    shopify.validTokens.add(token);
    return new Response(JSON.stringify({ access_token: token, scope: shopify.scopes, expires_in: 86_399 }), { status: 200 });
  }
  if (u.startsWith(`https://${SHOP}/admin/api/`)) {
    const token = (init?.headers as Record<string, string>)["X-Shopify-Access-Token"];
    if (!token || !shopify.validTokens.has(token)) return new Response(JSON.stringify({ errors: "[API] Invalid API key or access token" }), { status: 401 });
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    return new Response(JSON.stringify({ data: handleGraphQL(body.query, body.variables), extensions: { cost: { actualQueryCost: 5, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1990, restoreRate: 100 } } } }), { status: 200, headers: { "x-request-id": "fake" } });
  }
  throw new Error(`unexpected fetch ${u}`);
});

// ── fixtures ───────────────────────────────────────────────────────────────
let rechargeId = "", orgBRechargeId = "", shopifyIntegrationId = "", programId = "", scheduleId = "";
let whisk = "", cup = "";
const catalog = { whisk: { productId: "", variantId: "" }, cup: { productId: "", variantId: "" }, spoon: { productId: "", variantId: "" } };

beforeAll(async () => {
  vi.stubGlobal("fetch", fakeFetch);
  catalog.whisk = addProduct(91000, "Bamboo Whisk", "AE-WHISK", "6.00");
  catalog.cup = addProduct(92000, "Ceramic Cup", "AE-CUP", "12.00");
  catalog.spoon = addProduct(93000, "Wooden Spoon", "AE-SPOON", "4.00", { tracked: true });
  await prisma.organization.createMany({ data: [orgA, orgB] });
  rechargeId = (await prisma.integration.create({ data: { organizationId: orgA.id, provider: "RECHARGE", externalStoreId: `rc-${run}`, displayName: "AE Recharge (fake)", encryptedCredentials: "x", automationMode: "DRY_RUN" } })).id;
  orgBRechargeId = (await prisma.integration.create({ data: { organizationId: orgB.id, provider: "RECHARGE", externalStoreId: `rcB-${run}`, displayName: "B Recharge", encryptedCredentials: "x" } })).id;
  const prod = await prisma.product.create({ data: { organizationId: orgA.id, integrationId: rechargeId, externalProductId: "mm-prod", title: "Morning Magic Powder" } });
  programId = (await prisma.subscriptionProgram.create({ data: { organizationId: orgA.id, name: "Morning Magic Powder" } })).id;
  await prisma.subscriptionProgramProduct.create({ data: { organizationId: orgA.id, programId, productId: prod.id, variantId: null, variantScope: "*" } });
  whisk = ok(await upsertRewardItem(A, { name: "Whisk" })).id;
  cup = ok(await upsertRewardItem(A, { name: "Cup", operationalDescription: "Include cup" })).id;
  scheduleId = ok(await upsertRewardSchedule(A, { name: "Schedule B" })).id;
  ok(await upsertMilestone(A, { scheduleId, cycleNumber: 1, rewardItemId: whisk, eligibilityScope: "CUSTOMER_PROGRAM" }));
  ok(await upsertMilestone(A, { scheduleId, cycleNumber: 2, rewardItemId: cup, eligibilityScope: "CUSTOMER_PROGRAM" }));
  ok(await setRewardScheduleStatus(A, scheduleId, "READY"));
  ok(await assignProgramSchedule(A, { programId, scheduleId }));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  await prisma.$disconnect();
});

describe("connect with client credentials (read-only)", () => {
  it("wrong secret → AUTHENTICATION error, nothing saved; cross-org pairing refused; success stores encrypted creds + token cache", async () => {
    const bad = await testShopifyCredentials({ shopDomain: SHOP, clientId: CLIENT_ID, clientSecret: "wrong" });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/Client authentication failed|rejected the (client credentials|app credentials)/);

    const cross = await connectShopifyIntegration(A, { shopDomain: SHOP, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, pairedIntegrationId: orgBRechargeId });
    expect(cross.ok).toBe(false);
    expect(!cross.ok && cross.error).toMatch(/Recharge integration of this organisation/);

    const r = ok(await connectShopifyIntegration(A, { shopDomain: SHOP, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, pairedIntegrationId: rechargeId }));
    shopifyIntegrationId = r.integrationId;
    expect(r.report.requiredOk).toBe(true);
    expect(r.report.authMode).toBe("CLIENT_CREDENTIALS");
    expect(r.report.productsRead).toBe("available");
    expect(r.report.publicationsRead).toBe("not-granted"); // optional
    expect(r.report.grantedScopes).toEqual(["read_products"]);
    const row = await prisma.integration.findUniqueOrThrow({ where: { id: shopifyIntegrationId }, select: { provider: true, status: true, organizationId: true, pairedIntegrationId: true, automationMode: true, encryptedCredentials: true, encryptedAccessToken: true, accessTokenExpiresAt: true, settingsJson: true } });
    expect(row.provider).toBe("SHOPIFY");
    expect(row.organizationId).toBe(orgA.id);
    expect(row.pairedIntegrationId).toBe(rechargeId);
    expect(row.automationMode).toBe("OFF");
    expect(row.encryptedCredentials).not.toContain(CLIENT_SECRET); // encrypted at rest
    expect(row.encryptedAccessToken ?? "").not.toContain("shpat_fake"); // token cache encrypted too
    expect(row.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    const settings = row.settingsJson as { authMode: string; clientIdHint: string; shopDomain: string };
    expect(settings.authMode).toBe("CLIENT_CREDENTIALS");
    expect(settings.shopDomain).toBe(SHOP);
    expect(settings.clientIdHint).not.toBe(CLIENT_ID);
    expect(settings.clientIdHint.length).toBeLessThan(CLIENT_ID.length);
    expect(JSON.stringify(row.settingsJson)).not.toContain(CLIENT_SECRET);
  });
  it("the cached token is shared: a fresh connector performs reads without a new exchange", async () => {
    const before = shopify.tokenExchanges;
    const { connector } = await getShopifyConnectorForIntegration(A, shopifyIntegrationId);
    const store = await connector.getStore();
    expect(store.myshopifyDomain).toBe(SHOP);
    expect(shopify.tokenExchanges).toBe(before); // reused the encrypted cache
  });
  it("a revoked token refreshes automatically on 401 and the cache is updated", async () => {
    shopify.validTokens.clear(); // Shopify revoked everything
    const before = shopify.tokenExchanges;
    const { connector } = await getShopifyConnectorForIntegration(A, shopifyIntegrationId);
    const store = await connector.getStore();
    expect(store.name).toContain("Ancient Extracts");
    expect(shopify.tokenExchanges).toBe(before + 1);
  });
  it("re-check refreshes the capability report; org B can see none of it", async () => {
    const r = ok(await recheckShopifyIntegration(A, shopifyIntegrationId));
    expect(r.requiredOk).toBe(true);
    await expect(getShopifyConnectorForIntegration(B, shopifyIntegrationId)).rejects.toThrow(/not found in this organisation/);
    expect((await listRewardBindings(B)).shopifyIntegrations).toEqual([]);
  });
});

describe("search, bind, verify, unbind", () => {
  it("searches the catalogue read-only (term and numeric variant id)", async () => {
    const byTerm = await searchCatalog(A, shopifyIntegrationId, "cup");
    expect(byTerm.map((p) => p.title)).toEqual(["Ceramic Cup"]);
    expect(byTerm[0].variants[0]).toMatchObject({ variantId: catalog.cup.variantId, sku: "AE-CUP", price: "12.00" });
    const byId = await searchCatalog(A, shopifyIntegrationId, catalog.whisk.variantId);
    expect(byId.map((p) => p.title)).toEqual(["Bamboo Whisk"]);
  });
  it("binds Cup to its existing variant (no Shopify write), listing shows BOUND with the PRICED note", async () => {
    const before = shopify.gqlOps.length;
    const r = ok(await bindRewardItem(A, { rewardItemId: cup, shopifyIntegrationId, variantId: catalog.cup.variantId }));
    expect(r.issues).toEqual(["PRICED"]);
    expect(shopify.gqlOps.slice(before).every((o) => o.startsWith("SubscriptionOps"))).toBe(true); // reads only
    const b = await prisma.rewardItemExternalBinding.findUniqueOrThrow({ where: { id: r.bindingId } });
    expect(b).toMatchObject({ rewardItemId: cup, integrationId: shopifyIntegrationId, provider: "SHOPIFY", externalProductId: catalog.cup.productId, externalVariantId: catalog.cup.variantId, externalTitle: "Ceramic Cup", externalSku: "AE-CUP", externalPrice: "12.00", externalStatus: "ACTIVE", requiresShipping: true, inventoryTracked: false, active: true, rechargeCompatibility: "UNVERIFIED" });
    expect(b.lastVerifiedAt).toBeTruthy();
    const rows = (await listRewardBindings(A)).rows;
    expect(rows.find((x) => x.rewardItem.id === cup)?.status).toBe("BOUND");
    expect(rows.find((x) => x.rewardItem.id === whisk)?.status).toBe("NEEDS_BINDING");
  });
  it("one variant cannot represent two rewards (friendly error); rebinding the same reward re-points the SAME row and resets compatibility", async () => {
    const clash = await bindRewardItem(A, { rewardItemId: whisk, shopifyIntegrationId, variantId: catalog.cup.variantId });
    expect(clash.ok).toBe(false);
    expect(!clash.ok && clash.error).toMatch(/already bound to "Cup"/);

    ok(await bindRewardItem(A, { rewardItemId: whisk, shopifyIntegrationId, variantId: catalog.whisk.variantId }));
    await prisma.rewardItemExternalBinding.updateMany({ where: { rewardItemId: whisk }, data: { rechargeCompatibility: "VERIFIED" } });
    const rebound = ok(await bindRewardItem(A, { rewardItemId: whisk, shopifyIntegrationId, variantId: catalog.spoon.variantId }));
    const rowCount = await prisma.rewardItemExternalBinding.count({ where: { rewardItemId: whisk } });
    expect(rowCount).toBe(1); // same row re-pointed, not a second row
    const b = await prisma.rewardItemExternalBinding.findUniqueOrThrow({ where: { id: rebound.bindingId } });
    expect(b.externalVariantId).toBe(catalog.spoon.variantId);
    expect(b.rechargeCompatibility).toBe("UNVERIFIED"); // new variant → compatibility must be re-proven
    ok(await bindRewardItem(A, { rewardItemId: whisk, shopifyIntegrationId, variantId: catalog.whisk.variantId }));
  });
  it("resolver readiness flows through the binding; verify flags a vanished variant; unbind → REWARD_UNBOUND; rebind reactivates", async () => {
    let view = await resolveProgramRewards(A, programId);
    expect(view.store).toEqual({ rechargeIntegrationId: rechargeId, shopifyIntegrationId });
    expect(view.milestones.map((m) => [m.cycleNumber, m.readiness])).toEqual([[1, "INITIAL_CHECKOUT_NOT_PLANNED"], [2, "READY"]]);
    expect(view.milestones[1].binding?.externalVariantId).toBe(catalog.cup.variantId);

    // the Cup product disappears from Shopify → verify records MISSING_IN_SHOPIFY and readiness drops
    const gone = shopify.products.get(`gid://shopify/Product/${catalog.cup.productId}`)!;
    shopify.products.delete(gone.id);
    const cupBinding = await prisma.rewardItemExternalBinding.findFirstOrThrow({ where: { rewardItemId: cup } });
    const v = ok(await verifyRewardBinding(A, cupBinding.id));
    expect(v.issues).toEqual(["MISSING_IN_SHOPIFY"]);
    view = await resolveProgramRewards(A, programId);
    expect(view.milestones[1].readiness).toBe("BINDING_VARIANT_MISSING");
    shopify.products.set(gone.id, gone);
    expect(ok(await verifyRewardBinding(A, cupBinding.id)).issues).toEqual(["PRICED"]);
    expect((await resolveProgramRewards(A, programId)).milestones[1].readiness).toBe("READY");

    ok(await unbindRewardItem(A, { bindingId: cupBinding.id }));
    view = await resolveProgramRewards(A, programId);
    expect(view.milestones[1].readiness).toBe("BINDING_INACTIVE");
    expect((await listRewardBindings(A)).rows.find((x) => x.rewardItem.id === cup)?.status).toBe("INACTIVE");
    const again = ok(await bindRewardItem(A, { rewardItemId: cup, shopifyIntegrationId, variantId: catalog.cup.variantId }));
    expect(again.bindingId).toBe(cupBinding.id);
    expect((await resolveProgramRewards(A, programId)).milestones[1].readiness).toBe("READY");
  });
  it("tenant isolation: org B cannot search/bind/verify org A's store, and the DB trigger blocks a cross-org binding", async () => {
    await expect(searchCatalog(B, shopifyIntegrationId, "cup")).rejects.toThrow(/not found in this organisation/);
    expect((await bindRewardItem(B, { rewardItemId: cup, shopifyIntegrationId, variantId: catalog.cup.variantId })).ok).toBe(false);
    const cupBinding = await prisma.rewardItemExternalBinding.findFirstOrThrow({ where: { rewardItemId: cup } });
    expect((await verifyRewardBinding(B, cupBinding.id)).ok).toBe(false);
    expect((await unbindRewardItem(B, { bindingId: cupBinding.id })).ok).toBe(false);
    // raw cross-org insert (reward item of B, integration of A) → trigger refuses
    const bWhisk = ok(await upsertRewardItem(B, { name: "Whisk" })).id;
    await expect(prisma.rewardItemExternalBinding.create({ data: { organizationId: orgB.id, rewardItemId: bWhisk, integrationId: shopifyIntegrationId, provider: "SHOPIFY", externalProductId: "p", externalVariantId: "x1", externalTitle: "X" } })).rejects.toThrow();
    // tenant-scoped client cannot smuggle it either
    await expect(dbFor(B).rewardItemExternalBinding.create({ data: { organizationId: orgB.id, rewardItemId: bWhisk, integrationId: shopifyIntegrationId, provider: "SHOPIFY", externalProductId: "p", externalVariantId: "x2", externalTitle: "X" } })).rejects.toThrow();
    expect(await prisma.rewardItemExternalBinding.count({ where: { organizationId: orgB.id } })).toBe(0);
  });
  it("the fake Shopify only ever saw queries — never a mutation", () => {
    expect(shopify.gqlOps.every((o) => o.startsWith("SubscriptionOps"))).toBe(true);
  });
});

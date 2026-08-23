/**
 * Phase 4c — Shopify marker integration, end to end against a fake Shopify Admin GraphQL endpoint
 * (global fetch stub) and the real database:
 *   - connect a SHOPIFY integration (encrypted creds, capability report, pairing with Recharge)
 *   - "missing markers" preview (placeholder-bound milestone counts as missing)
 *   - duplicate detection → POSSIBLE_EXISTING_MARKER (SKU / title / internal), adopt path
 *   - explicit create → product created in target state, marker replaces the placeholder completely,
 *     binding READY, planner-visible
 *   - verify (read-only) records state + issues
 *   - DB guarantees: one active marker per (shopifyIntegration, variant); tenant isolation of the
 *     Shopify integration / marker ownership (FK + tenant-scoped client)
 *   - the fake Shopify only ever sees product/publication operations (no order/customer traffic)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { dbFor } from "@/lib/db/tenant";
import { assignProgramSchedule, bindProgramMarker, setRewardScheduleStatus, upsertMilestone, upsertRewardItem, upsertRewardSchedule } from "@/lib/domain/rewards/core";
import { resolveProgramRewards } from "@/lib/domain/rewards/resolver";
import { connectShopifyIntegration, findShopifyIntegrationForRecharge, getShopifyConnectorForIntegration, recheckShopifyIntegration } from "@/lib/domain/integrations/shopify";
import { adoptShopifyVariant, createMarkerInShopify, findExistingMarkerCandidates, listMissingMarkers, setProgramMarkerNaming, verifyMarkerInShopify } from "@/lib/domain/markers/shopify";
import { MARKER_PRODUCT_TYPE, MARKER_TAG, REQUIRED_SHOPIFY_SCOPES } from "@/lib/integrations/shopify";

const run = Math.random().toString(36).slice(2, 8);
const orgA = { id: `test_shA_${run}`, slug: `test-sha-${run}`, name: "Shopify A" };
const orgB = { id: `test_shB_${run}`, slug: `test-shb-${run}`, name: "Shopify B" };
const A = { organizationId: orgA.id, userId: null };
const B = { organizationId: orgB.id, userId: null };
const SHOP = `ae-${run}.myshopify.com`;
const ONLINE_STORE = "gid://shopify/Publication/111";

function ok<T>(r: { ok: true; data?: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.data as T;
}

// ── fake Shopify ───────────────────────────────────────────────────────────
type FakeVariant = { id: string; sku: string | null; price: string; tracked: boolean };
type FakeProduct = { id: string; title: string; handle: string; status: string; productType: string; tags: string[]; published: boolean; variants: FakeVariant[] };
const shopify = { products: new Map<string, FakeProduct>(), nextId: 7000, ops: [] as string[], scopes: [...REQUIRED_SHOPIFY_SCOPES] as string[] };
function node(p: FakeProduct, withPublication: boolean) {
  return { id: p.id, title: p.title, handle: p.handle, status: p.status, productType: p.productType, tags: p.tags, vendor: "AE", onlineStoreUrl: null, updatedAt: "2026-08-23T20:00:00Z", ...(withPublication ? { publishedOnPublication: p.published } : {}), variants: { nodes: p.variants.map((v) => ({ id: v.id, title: "Default Title", sku: v.sku, price: v.price, inventoryItem: { id: v.id.replace("ProductVariant", "InventoryItem"), tracked: v.tracked, requiresShipping: true } })) } };
}
function addFakeProduct(input: { title: string; sku: string | null; price?: string; status?: string; published?: boolean; tracked?: boolean; tags?: string[]; productType?: string }): FakeProduct {
  const id = `gid://shopify/Product/${shopify.nextId++}`;
  const p: FakeProduct = { id, title: input.title, handle: input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), status: input.status ?? "ACTIVE", productType: input.productType ?? "", tags: input.tags ?? [], published: input.published ?? true, variants: [{ id: `gid://shopify/ProductVariant/${shopify.nextId++}`, sku: input.sku, price: input.price ?? "0.00", tracked: input.tracked ?? false }] };
  shopify.products.set(id, p);
  return p;
}
function handle(query: string, vars: Record<string, unknown>): unknown {
  const m = /^\s*(query|mutation)\s+([A-Za-z]+)/.exec(query);
  const op = m?.[2] ?? "?";
  shopify.ops.push(op);
  switch (op) {
    case "SubscriptionOpsShop":
      return { shop: { id: "gid://shopify/Shop/1", name: "Ancient Extracts (fake)", myshopifyDomain: SHOP, primaryDomain: { host: "ancientextracts.co.uk" }, currencyCode: "GBP", plan: { displayName: "Shopify" }, ianaTimezone: "Europe/London" } };
    case "SubscriptionOpsScopes":
      return { currentAppInstallation: { accessScopes: shopify.scopes.map((handle) => ({ handle })) } };
    case "SubscriptionOpsProductsProbe":
      return { products: { nodes: [] } };
    case "SubscriptionOpsPublications":
      return { publications: { nodes: [{ id: ONLINE_STORE, name: "Online Store", catalog: null }, { id: "gid://shopify/Publication/222", name: "Shop", catalog: null }] } };
    case "SubscriptionOpsSearchProducts": {
      const q = String(vars.query);
      const withPub = !!vars.withPublication;
      const sku = /^sku:"(.*)"$/.exec(q)?.[1]?.replace(/\\"/g, '"');
      const title = /^title:"(.*)"$/.exec(q)?.[1]?.replace(/\\"/g, '"');
      const nodes = [...shopify.products.values()].filter((p) => (sku ? p.variants.some((v) => (v.sku ?? "").toLowerCase() === sku.toLowerCase()) : title ? p.title.toLowerCase().includes(title.toLowerCase()) : false)).map((p) => node(p, withPub));
      return { products: { nodes } };
    }
    case "SubscriptionOpsProduct": {
      const p = shopify.products.get(String(vars.id));
      return { product: p ? node(p, !!vars.withPublication) : null };
    }
    case "SubscriptionOpsVariant": {
      const p = [...shopify.products.values()].find((x) => x.variants.some((v) => v.id === vars.id));
      return { productVariant: p ? { id: vars.id, product: node(p, !!vars.withPublication) } : null };
    }
    case "productCreate": {
      const input = vars.product as { title: string; status: string; productType: string; tags: string[] };
      const p = addFakeProduct({ title: input.title, sku: null, status: input.status, published: false, productType: input.productType, tags: input.tags });
      return { productCreate: { product: { id: p.id, variants: { nodes: [{ id: p.variants[0].id }] } }, userErrors: [] } };
    }
    case "productVariantsBulkUpdate": {
      const p = shopify.products.get(String(vars.productId))!;
      for (const v of vars.variants as { id: string; price?: string; inventoryItem?: { sku?: string; tracked?: boolean } }[]) {
        const fv = p.variants.find((x) => x.id === v.id)!;
        if (v.price !== undefined) fv.price = v.price;
        if (v.inventoryItem?.sku !== undefined) fv.sku = v.inventoryItem.sku;
        if (v.inventoryItem?.tracked !== undefined) fv.tracked = v.inventoryItem.tracked;
      }
      return { productVariantsBulkUpdate: { productVariants: p.variants.map((v) => ({ id: v.id, sku: v.sku, price: v.price })), userErrors: [] } };
    }
    case "publishablePublish": {
      const p = shopify.products.get(String(vars.id))!;
      p.published = true;
      return { publishablePublish: { userErrors: [] } };
    }
    default:
      throw new Error(`fake shopify: unhandled operation ${op}`);
  }
}
const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  if (!u.startsWith(`https://${SHOP}/admin/api/`)) throw new Error(`unexpected fetch ${u}`);
  const token = (init?.headers as Record<string, string>)["X-Shopify-Access-Token"];
  if (token !== `shpat_${run}_secret`) return new Response(JSON.stringify({ errors: "[API] Invalid API key or access token" }), { status: 401 });
  const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
  return new Response(JSON.stringify({ data: handle(body.query, body.variables), extensions: { cost: { actualQueryCost: 5, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1990, restoreRate: 100 } } } }), { status: 200, headers: { "x-request-id": "fake" } });
});

// ── fixtures ───────────────────────────────────────────────────────────────
let rechargeId = "", programId = "", scheduleId = "", milestone2 = "", placeholderId = "", placeholderVariantRowId = "", shopifyIntegrationId = "", cup = "", whisk = "";
let orgBRechargeId = "";

beforeAll(async () => {
  vi.stubGlobal("fetch", fakeFetch);
  await prisma.organization.createMany({ data: [orgA, orgB] });
  const integ = await prisma.integration.create({ data: { organizationId: orgA.id, provider: "RECHARGE", externalStoreId: `rc-${run}`, displayName: "AE Recharge (fake)", encryptedCredentials: "x", automationMode: "DRY_RUN" } });
  rechargeId = integ.id;
  const prod = await prisma.product.create({ data: { organizationId: orgA.id, integrationId: rechargeId, externalProductId: "mm-prod", title: "Morning Magic Powder" } });
  await prisma.productVariant.create({ data: { organizationId: orgA.id, productId: prod.id, externalVariantId: "mm-v1", title: "1 tub" } });
  programId = (await prisma.subscriptionProgram.create({ data: { organizationId: orgA.id, name: "Morning Magic Powder" } })).id;
  await prisma.subscriptionProgramProduct.create({ data: { organizationId: orgA.id, programId, productId: prod.id, variantId: null, variantScope: "*" } });
  whisk = ok(await upsertRewardItem(A, { name: "Whisk" })).id;
  cup = ok(await upsertRewardItem(A, { name: "Cup", operationalDescription: "Include cup" })).id;
  scheduleId = ok(await upsertRewardSchedule(A, { name: "Schedule B — Morning Magic / Evening Elixir" })).id;
  ok(await upsertMilestone(A, { scheduleId, cycleNumber: 1, rewardItemId: whisk, eligibilityScope: "CUSTOMER_PROGRAM" }));
  milestone2 = ok(await upsertMilestone(A, { scheduleId, cycleNumber: 2, rewardItemId: cup, eligibilityScope: "CUSTOMER_PROGRAM" })).id;
  ok(await upsertMilestone(A, { scheduleId, cycleNumber: 3, rewardItemId: whisk, eligibilityScope: "CUSTOMER_PROGRAM" }));
  ok(await setRewardScheduleStatus(A, scheduleId, "READY"));
  ok(await assignProgramSchedule(A, { programId, scheduleId }));
  // placeholder marker (a discovered Cacao one-time), bound to delivery 2 — exactly AE's state before 4c
  const php = await prisma.product.create({ data: { organizationId: orgA.id, integrationId: rechargeId, externalProductId: "cacao-prod", title: "Ceremonial Cacao (placeholder)", type: "FULFILMENT_MARKER" } });
  const phv = await prisma.productVariant.create({ data: { organizationId: orgA.id, productId: php.id, externalVariantId: "56259577545090", title: "Cacao", price: "0.00" } });
  placeholderVariantRowId = phv.id;
  placeholderId = (await prisma.fulfillmentMarker.create({ data: { organizationId: orgA.id, integrationId: rechargeId, name: "MM delivery 2 (placeholder)", variantId: phv.id, externalVariantId: "56259577545090", externalProductId: "cacao-prod", title: "Ceremonial Cacao", sku: "CACAO", source: "DISCOVERED_ONETIME", placeholder: true, rewardItemId: cup } })).id;
  ok(await bindProgramMarker(A, { programId, milestoneId: milestone2, fulfillmentMarkerId: placeholderId }));
  // org B has its own Recharge store (for tenant tests)
  orgBRechargeId = (await prisma.integration.create({ data: { organizationId: orgB.id, provider: "RECHARGE", externalStoreId: `rcB-${run}`, displayName: "B Recharge", encryptedCredentials: "x" } })).id;
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  await prisma.$disconnect();
});

describe("connect Shopify (catalogue + markers only)", () => {
  it("refuses a bad token, refuses pairing with another organisation's Recharge store, connects with encrypted credentials + capability report", async () => {
    const bad = await connectShopifyIntegration(A, { shopDomain: SHOP, accessToken: "shpat_wrong_token_000000", pairedIntegrationId: rechargeId });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/rejected the access token/);

    const cross = await connectShopifyIntegration(A, { shopDomain: SHOP, accessToken: `shpat_${run}_secret`, pairedIntegrationId: orgBRechargeId });
    expect(cross.ok).toBe(false);
    expect(!cross.ok && cross.error).toMatch(/Recharge integration of this organisation/);

    const r = ok(await connectShopifyIntegration(A, { shopDomain: SHOP, accessToken: `shpat_${run}_secret`, pairedIntegrationId: rechargeId }));
    shopifyIntegrationId = r.integrationId;
    expect(r.report.requiredOk).toBe(true);
    expect(r.report.onlineStorePublicationId).toBe(ONLINE_STORE);
    const row = await prisma.integration.findUniqueOrThrow({ where: { id: shopifyIntegrationId }, select: { provider: true, organizationId: true, pairedIntegrationId: true, automationMode: true, encryptedCredentials: true, settingsJson: true } });
    expect(row.provider).toBe("SHOPIFY");
    expect(row.organizationId).toBe(orgA.id);
    expect(row.pairedIntegrationId).toBe(rechargeId);
    expect(row.automationMode).toBe("OFF");
    expect(row.encryptedCredentials).not.toContain("secret"); // encrypted at rest
    expect((row.settingsJson as { onlineStorePublicationId: string }).onlineStorePublicationId).toBe(ONLINE_STORE);
    expect((await findShopifyIntegrationForRecharge(A, rechargeId))?.id).toBe(shopifyIntegrationId);
    // org B cannot see or use it
    expect(await findShopifyIntegrationForRecharge(B, rechargeId)).toBeNull();
    await expect(getShopifyConnectorForIntegration(B, shopifyIntegrationId)).rejects.toThrow(/not found in this organisation/);
  });
  it("re-check refreshes the report and flags missing scopes without disconnecting", async () => {
    shopify.scopes = ["read_products", "write_products", "read_publications"];
    const r = ok(await recheckShopifyIntegration(A, shopifyIntegrationId));
    expect(r.requiredOk).toBe(false);
    expect(r.missingScopes).toEqual(["write_publications"]);
    shopify.scopes = [...REQUIRED_SHOPIFY_SCOPES];
    expect(ok(await recheckShopifyIntegration(A, shopifyIntegrationId)).requiredOk).toBe(true);
  });
});

describe("missing markers preview + naming", () => {
  it("lists renewal milestones without a real marker (placeholder counts as missing; INITIAL_CHECKOUT excluded) with proposed titles/SKUs", async () => {
    ok(await setProgramMarkerNaming(A, { programId, markerLabel: "Morning Magic", skuPrefix: "MM" }));
    const rows = await listMissingMarkers(A);
    expect(rows.map((r) => r.cycleNumber)).toEqual([2, 3]);
    const d2 = rows.find((r) => r.cycleNumber === 2)!;
    expect(d2.proposedTitle).toBe("Morning Magic 2");
    expect(d2.proposedSku).toBe("MM-CYCLE-02");
    expect(d2.rewardItemName).toBe("Cup");
    expect(d2.placeholderMarkerId).toBe(placeholderId);
    expect(d2.shopifyIntegrationId).toBe(shopifyIntegrationId);
    expect(d2.rechargeIntegrationId).toBe(rechargeId);
    expect(rows.find((r) => r.cycleNumber === 3)!.proposedSku).toBe("MM-CYCLE-03");
    // naming is validated
    expect((await setProgramMarkerNaming(A, { programId, markerLabel: "M", skuPrefix: "bad prefix!" })).ok).toBe(false);
    // org B sees nothing of org A
    expect(await listMissingMarkers(B)).toEqual([]);
  });
});

describe("duplicate detection, create, adopt, verify", () => {
  it("flags an existing Shopify product with the same SKU/title and refuses to create until acknowledged", async () => {
    const existing = addFakeProduct({ title: "Morning Magic 2", sku: "MM-CYCLE-02", status: "ACTIVE", published: true });
    const { connector } = await getShopifyConnectorForIntegration(A, shopifyIntegrationId);
    const candidates = await findExistingMarkerCandidates(A, connector, { sku: "MM-CYCLE-02", title: "Morning Magic 2", shopifyIntegrationId, rechargeIntegrationId: rechargeId });
    expect(candidates.map((c) => c.matchedBy).sort()).toEqual(["SKU", "TITLE"]);
    expect(candidates[0].product?.productId).toBe(existing.id.split("/").pop());

    const refused = await createMarkerInShopify(A, { programId, milestoneId: milestone2, title: "Morning Magic 2", sku: "MM-CYCLE-02", replaceMarkerId: placeholderId });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.code).toBe("POSSIBLE_EXISTING_MARKER");
    expect(!refused.ok && refused.candidates?.length).toBe(2);
    expect(shopify.ops.filter((o) => o === "productCreate")).toHaveLength(0); // nothing created
    // clean up the decoy so the real create below is a clean path
    shopify.products.delete(existing.id);
  });
  it("creates Morning Magic 2 in the target state, replaces the placeholder completely, binds it and the milestone becomes READY", async () => {
    const r = ok(await createMarkerInShopify(A, { programId, milestoneId: milestone2, title: "Morning Magic 2", sku: "MM-CYCLE-02", replaceMarkerId: placeholderId }));
    expect(r.markerId).toBe(placeholderId); // same marker row, re-pointed
    expect(r.product.status).toBe("UNLISTED");
    expect(r.product.publishedOnlineStore).toBe(true);
    expect(r.product.productType).toBe(MARKER_PRODUCT_TYPE);
    expect(r.product.tags).toContain(MARKER_TAG);
    expect(r.product.variants[0].price).toBe("0.00");
    expect(r.product.variants[0].sku).toBe("MM-CYCLE-02");
    expect(r.product.variants[0].inventoryTracked).toBe(false);

    const marker = await prisma.fulfillmentMarker.findUniqueOrThrow({ where: { id: placeholderId }, include: { variant: { include: { product: true } } } });
    expect(marker.placeholder).toBe(false);
    expect(marker.name).toBe("Morning Magic 2");
    expect(marker.title).toBe("Morning Magic 2");
    expect(marker.sku).toBe("MM-CYCLE-02");
    expect(marker.externalVariantId).toBe(r.variantId);
    expect(marker.externalProductId).toBe(r.productId);
    expect(marker.externalVariantId).not.toBe("56259577545090"); // Cacao identity gone
    expect(marker.shopifyIntegrationId).toBe(shopifyIntegrationId);
    expect(marker.shopifyStatus).toBe("UNLISTED");
    expect(marker.shopifyPublishedOnlineStore).toBe(true);
    expect(marker.shopifyPrice).toBe("0.00");
    expect(marker.shopifyInventoryTracked).toBe(false);
    expect(marker.rechargeCompatibility).toBe("UNVERIFIED");
    expect(marker.rewardItemId).toBe(cup);
    expect(marker.operationalNote).toBe("Include cup");
    expect(marker.lastVerifiedAt).toBeTruthy();
    expect(marker.variant.externalVariantId).toBe(r.variantId);
    expect(marker.variant.product.externalProductId).toBe(r.productId);
    expect(marker.variant.product.type).toBe("FULFILMENT_MARKER");
    // orphaned placeholder catalogue rows removed
    expect(await prisma.productVariant.findUnique({ where: { id: placeholderVariantRowId } })).toBeNull();
    expect(await prisma.product.findFirst({ where: { organizationId: orgA.id, externalProductId: "cacao-prod" } })).toBeNull();

    const view = await resolveProgramRewards(A, programId);
    const d2 = view.milestones.find((m) => m.cycleNumber === 2)!;
    expect(d2.readiness).toBe("READY");
    expect(d2.marker?.id).toBe(placeholderId);
    expect(d2.marker?.placeholder).toBe(false);
    expect((await listMissingMarkers(A)).map((x) => x.cycleNumber)).toEqual([3]);
    // second create for the same milestone is now refused as a duplicate (internal marker + Shopify SKU/title)
    const again = await createMarkerInShopify(A, { programId, milestoneId: milestone2, title: "Morning Magic 2", sku: "MM-CYCLE-02" });
    expect(again.ok).toBe(false);
    expect(!again.ok && again.code).toBe("POSSIBLE_EXISTING_MARKER");
  });
  it("adopts an existing Shopify variant for delivery 3 (read-only on Shopify) and records its real state", async () => {
    const existing = addFakeProduct({ title: "Morning Magic 3", sku: "MM-CYCLE-03", status: "ACTIVE", published: true, tracked: true });
    const variantId = existing.variants[0].id.split("/").pop()!;
    const milestone3 = (await prisma.rewardScheduleMilestone.findFirstOrThrow({ where: { scheduleId, cycleNumber: 3 } })).id;
    const before = shopify.ops.filter((o) => /^(productCreate|productUpdate|productVariantsBulkUpdate|publishablePublish)$/.test(o)).length;
    const r = ok(await adoptShopifyVariant(A, { programId, milestoneId: milestone3, variantId }));
    expect(shopify.ops.filter((o) => /^(productCreate|productUpdate|productVariantsBulkUpdate|publishablePublish)$/.test(o)).length).toBe(before); // no writes
    const marker = await prisma.fulfillmentMarker.findUniqueOrThrow({ where: { id: r.markerId } });
    expect(marker.externalVariantId).toBe(variantId);
    expect(marker.shopifyStatus).toBe("ACTIVE");
    expect(marker.shopifyInventoryTracked).toBe(true);
    expect(marker.rewardItemId).toBe(whisk);
    expect(marker.placeholder).toBe(false);
    const view = await resolveProgramRewards(A, programId);
    expect(view.milestones.find((m) => m.cycleNumber === 3)!.readiness).toBe("READY");
    // verification reports the deviations from the target state
    const v = ok(await verifyMarkerInShopify(A, r.markerId));
    expect(v.issues).toEqual(["VISIBLE_TO_CUSTOMERS", "INVENTORY_TRACKED", "MISSING_MARKER_TAG"]);
    expect((await prisma.fulfillmentMarker.findUniqueOrThrow({ where: { id: r.markerId } })).verificationJson).toMatchObject({ issues: ["VISIBLE_TO_CUSTOMERS", "INVENTORY_TRACKED", "MISSING_MARKER_TAG"] });
    // adopting a variant nobody has → clear error; a non-numeric id is rejected
    expect((await adoptShopifyVariant(A, { programId, milestoneId: milestone3, variantId: "999999999" })).ok).toBe(false);
    expect((await adoptShopifyVariant(A, { programId, milestoneId: milestone3, variantId: "abc" })).ok).toBe(false);
  });
  it("verify on the created marker: no issues; a variant deleted in Shopify → MISSING_IN_SHOPIFY", async () => {
    const v = ok(await verifyMarkerInShopify(A, placeholderId));
    expect(v.issues).toEqual([]);
    expect(v.product?.status).toBe("UNLISTED");
    const marker = await prisma.fulfillmentMarker.findUniqueOrThrow({ where: { id: placeholderId } });
    const gone = [...shopify.products.values()].find((p) => p.id.endsWith(`/${marker.externalProductId}`))!;
    shopify.products.delete(gone.id);
    expect(ok(await verifyMarkerInShopify(A, placeholderId)).issues).toEqual(["MISSING_IN_SHOPIFY"]);
    expect((await prisma.fulfillmentMarker.findUniqueOrThrow({ where: { id: placeholderId } })).shopifyStatus).toBeNull();
    shopify.products.set(gone.id, gone);
    expect(ok(await verifyMarkerInShopify(A, placeholderId)).issues).toEqual([]);
  });
  it("the fake Shopify never received anything but product/publication operations", () => {
    expect(shopify.ops.every((o) => /^(SubscriptionOps(Shop|Scopes|ProductsProbe|Publications|SearchProducts|Product|Variant)|productCreate|productVariantsBulkUpdate|publishablePublish)$/.test(o))).toBe(true);
    expect(shopify.ops.some((o) => /order|customer|fulfil/i.test(o))).toBe(false);
  });
});

describe("database guarantees + tenant isolation", () => {
  it("two active markers in one Shopify integration cannot claim the same variant id", async () => {
    const marker = await prisma.fulfillmentMarker.findUniqueOrThrow({ where: { id: placeholderId } });
    const p = await prisma.product.create({ data: { organizationId: orgA.id, integrationId: rechargeId, externalProductId: "other-prod", title: "Other", type: "FULFILMENT_MARKER" } });
    const v = await prisma.productVariant.create({ data: { organizationId: orgA.id, productId: p.id, externalVariantId: "other-v", title: "Other" } });
    await expect(prisma.fulfillmentMarker.create({ data: { organizationId: orgA.id, integrationId: rechargeId, name: "Clash", variantId: v.id, externalVariantId: marker.externalVariantId, shopifyIntegrationId, rewardItemId: cup } })).rejects.toThrow(/externalVariantId|Unique constraint/);
  });
  it("a marker cannot reference another organisation's Shopify integration through the tenant-scoped client, and org B cannot verify/adopt/create against org A's store", async () => {
    const pB = await prisma.product.create({ data: { organizationId: orgB.id, integrationId: orgBRechargeId, externalProductId: "b-prod", title: "B", type: "FULFILMENT_MARKER" } });
    const vB = await prisma.productVariant.create({ data: { organizationId: orgB.id, productId: pB.id, externalVariantId: "b-v", title: "B" } });
    // tenant-scoped create: the shopifyIntegrationId belongs to org A → refused (FK/tenancy guard), never silently created
    await expect(dbFor(B).fulfillmentMarker.create({ data: { organizationId: orgB.id, integrationId: orgBRechargeId, name: "B marker", variantId: vB.id, externalVariantId: "b-v", shopifyIntegrationId } })).rejects.toThrow();
    expect(await prisma.fulfillmentMarker.count({ where: { organizationId: orgB.id } })).toBe(0);
    // org B cannot act on org A's marker or programme
    expect((await verifyMarkerInShopify(B, placeholderId)).ok).toBe(false);
    expect((await createMarkerInShopify(B, { programId, milestoneId: milestone2, title: "X 2", sku: "X-CYCLE-02" })).ok).toBe(false);
    expect((await adoptShopifyVariant(B, { programId, milestoneId: milestone2, variantId: "1" })).ok).toBe(false);
    // a Shopify integration row whose pairing is another org's Recharge store cannot be created through the tenant client
    await expect(dbFor(B).integration.create({ data: { organizationId: orgB.id, provider: "SHOPIFY", externalStoreId: `x-${run}.myshopify.com`, displayName: "X", encryptedCredentials: "x", pairedIntegrationId: rechargeId } })).rejects.toThrow();
  });
});

/**
 * Shopify-checkout stores: Recharge 2021-11 rejects GET /products with
 * 422 "This API is not compatible with your platform". The sync must then
 * derive Products/Variants from subscriptions and order lines, and the
 * capability probe must report products as "derived" (counts as available).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { RechargeError } from "@/lib/integrations/recharge/errors";
import type { RechargeConnector } from "@/lib/integrations/recharge";
import type { ConnectorOrder, ConnectorSubscription } from "@/lib/integrations/types";
import { requiredCapabilitiesAvailable } from "@/lib/integrations/types";
import { importOrdersPage, importProductsPage, importSubscriptionsPage, isProductsEndpointUnavailable } from "@/lib/domain/sync/stages";

const run = Math.random().toString(36).slice(2, 8);
const org = { id: `test_derived_${run}`, slug: `test-derived-${run}`, name: "Derived Test" };
let integrationId = "";

const platformError = () => new RechargeError("VALIDATION_ERROR", 'Recharge rejected the request as invalid: {"platform":["This API is not compatible with your platform"]}', { status: 422 });

const sub: ConnectorSubscription = {
  externalSubscriptionId: "501", externalCustomerId: "9", externalAddressId: "a", status: "active", providerStatus: "active",
  externalProductId: "8001", externalVariantId: "9001", productTitle: "Morning Magic", variantTitle: "30 servings", sku: "MM-30", quantity: 1, price: "34.00",
  intervalUnit: "day", intervalFrequency: 30, nextChargeDate: "2026-09-21", externalCreatedAt: new Date("2026-01-01"), externalUpdatedAt: null, cancelledAt: null, providerData: null,
};
const order: ConnectorOrder = {
  externalOrderId: "7001", externalCustomerId: "9", externalAddressId: "a", externalChargeId: null, platformOrderId: null, status: "success", kind: "RECURRING", processedAt: new Date("2025-06-01"), scheduledAt: null,
  lineItems: [{ purchaseItemId: "501", purchaseItemType: "subscription", externalProductId: "8002", externalVariantId: "9002", quantity: 1, title: "Old Formula", sku: "OLD-1" }],
};
async function* onePage<T>(items: T[]) { yield { items, nextCursor: null, page: 1, skipped: 0, skippedVariants: 0 }; }
const fake = {
  listProducts: async function* () { throw platformError(); },
  listSubscriptions: (o: { status: string }) => onePage(o.status === "active" ? [sub] : []),
  listOrders: () => onePage([order]),
} as unknown as RechargeConnector;

beforeAll(async () => {
  await prisma.organization.create({ data: org });
  const integ = await prisma.integration.create({ data: { organizationId: org.id, provider: "RECHARGE", externalStoreId: `s-${run}`, displayName: "Fake", encryptedCredentials: "x" } });
  integrationId = integ.id;
});
afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: org.id } });
  await prisma.$disconnect();
});

describe("derived catalogue when /products is unavailable", () => {
  it("recognises the platform error and 'derived' counts as available", () => {
    expect(isProductsEndpointUnavailable(platformError())).toBe(true);
    expect(isProductsEndpointUnavailable(new RechargeError("VALIDATION_ERROR", "other", { status: 422 }))).toBe(false);
    expect(requiredCapabilitiesAvailable({ store: "available", customers: "available", products: "derived", orders: "available", subscriptions: "read_write", onetimes: "read_write", webhooks: "available", charges: "unknown", events: "unavailable", credits: "unavailable", customer_sessions: "unavailable" })).toBe(true);
  });

  it("products stage completes without throwing and records the flag", async () => {
    const r = await importProductsPage({ organizationId: org.id }, fake, integrationId, null);
    expect(r.nextCursor).toBeNull();
    expect(r.delta.productsEndpointUnavailable).toBe(1);
  });

  it("subscriptions + orders derive products/variants with titles and SKUs, idempotently", async () => {
    const ctx = { organizationId: org.id, timezone: "Europe/London" };
    await importSubscriptionsPage(ctx, fake, integrationId, "active", null);
    await importOrdersPage(ctx, fake, integrationId, null);
    await importSubscriptionsPage(ctx, fake, integrationId, "active", null);
    await importOrdersPage(ctx, fake, integrationId, null);
    const products = await prisma.product.findMany({ where: { organizationId: org.id }, include: { variants: true }, orderBy: { externalProductId: "asc" } });
    expect(products.map((p) => [p.externalProductId, p.title])).toEqual([["8001", "Morning Magic"], ["8002", "Old Formula"]]);
    expect(products[0].variants.map((v) => [v.externalVariantId, v.title, v.sku])).toEqual([["9001", "30 servings", "MM-30"]]);
    expect(products[1].variants.map((v) => [v.externalVariantId, v.sku])).toEqual([["9002", "OLD-1"]]);
    const s = await prisma.subscription.findFirstOrThrow({ where: { organizationId: org.id } });
    expect(s.productId).toBe(products[0].id);
    expect(s.variantId).toBe(products[0].variants[0].id);
  });
});

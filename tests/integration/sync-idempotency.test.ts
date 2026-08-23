/**
 * Sync idempotency (Phase 2 constraint 5): running the import stages twice over
 * the same provider data produces identical internal state — no duplicate
 * products, variants, customers, subscriptions, order facts or journeys — and a
 * partial re-run after "failure" converges to the same state.
 *
 * Uses a fake connector (no network) feeding the real stage functions.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import type { RechargeConnector } from "@/lib/integrations/recharge";
import type { ConnectorCustomer, ConnectorOrder, ConnectorProduct, ConnectorSubscription } from "@/lib/integrations/types";
import { importCustomersPage, importOrdersPage, importProductsPage, importSubscriptionsPage, recalculateJourneysBatch, relinkOrphanOrders } from "@/lib/domain/sync/stages";

const run = Math.random().toString(36).slice(2, 8);
const org = { id: `test_sync_${run}`, slug: `test-sync-${run}`, name: "Sync Test" };
let integrationId = "";
let programId = "";

const products: ConnectorProduct[] = [
  { externalProductId: "8001", providerProductId: "1", title: "Morning Magic", active: true, providerData: null, skippedVariants: 0, variants: [{ externalVariantId: "9001", title: "30", sku: "MM-30", price: "34.00" }, { externalVariantId: "9002", title: "60", sku: "MM-60", price: "62.00" }] },
  { externalProductId: "8002", providerProductId: "2", title: "Ube", active: true, providerData: null, skippedVariants: 0, variants: [{ externalVariantId: "9003", title: "200g", sku: "UBE", price: "24.00" }] },
];
const customers: ConnectorCustomer[] = [
  { externalCustomerId: "55", email: "sarah@example.com", firstName: "Sarah", lastName: "Johnson", externalCreatedAt: new Date("2026-01-01"), externalUpdatedAt: null },
  { externalCustomerId: "56", email: "james@example.com", firstName: "James", lastName: "Whitfield", externalCreatedAt: new Date("2026-01-01"), externalUpdatedAt: null },
];
const subs: ConnectorSubscription[] = [
  { externalSubscriptionId: "123", externalCustomerId: "55", externalAddressId: "a1", status: "active", providerStatus: "active", externalProductId: "8001", externalVariantId: "9001", productTitle: "Morning Magic", variantTitle: "30", sku: "MM-30", quantity: 1, price: "34.00", intervalUnit: "day", intervalFrequency: 30, nextChargeDate: "2026-09-21", externalCreatedAt: new Date("2026-01-05"), externalUpdatedAt: null, cancelledAt: null, providerData: null },
  { externalSubscriptionId: "124", externalCustomerId: "56", externalAddressId: "a2", status: "active", providerStatus: "active", externalProductId: "8002", externalVariantId: "9003", productTitle: "Ube", variantTitle: "200g", sku: "UBE", quantity: 1, price: "24.00", intervalUnit: "day", intervalFrequency: 30, nextChargeDate: "2026-09-10", externalCreatedAt: new Date("2026-02-05"), externalUpdatedAt: null, cancelledAt: null, providerData: null },
];
const mkOrder = (id: string, at: string, subId: string, kind: "CHECKOUT" | "RECURRING", product = "8001", variant = "9001"): ConnectorOrder => ({
  externalOrderId: id,
  externalCustomerId: "55",
  externalAddressId: "a1",
  externalChargeId: `c${id}`,
  platformOrderId: `S${id}`,
  status: "success",
  kind,
  processedAt: new Date(at),
  scheduledAt: null,
  lineItems: [{ purchaseItemId: subId, purchaseItemType: "subscription", externalProductId: product, externalVariantId: variant, quantity: 1, title: "x", sku: null }],
});
const orders: ConnectorOrder[] = [mkOrder("5001", "2026-01-05", "123", "CHECKOUT"), mkOrder("5002", "2026-02-05", "123", "RECURRING", "8001", "9002"), mkOrder("5003", "2026-03-05", "123", "RECURRING"), mkOrder("6001", "2026-02-05", "124", "CHECKOUT", "8002", "9003")];

async function* onePage<T>(items: T[]) {
  yield { items, nextCursor: null, page: 1, skipped: 0 };
}
const fake = {
  listProducts: () => onePage(products),
  listCustomers: () => onePage(customers),
  listSubscriptions: (o: { status: string }) => onePage(subs.filter((s) => s.status === o.status)),
  listOrders: () => onePage(orders),
} as unknown as RechargeConnector;

const ctx = () => ({ organizationId: org.id, timezone: "Europe/London" });

async function runAllStages() {
  await importProductsPage(ctx(), fake, integrationId, null);
  await importCustomersPage(ctx(), fake, integrationId, null);
  for (const status of ["active", "cancelled", "expired"] as const) await importSubscriptionsPage(ctx(), fake, integrationId, status, null);
  await importOrdersPage(ctx(), fake, integrationId, null);
  await relinkOrphanOrders(ctx(), integrationId);
  await recalculateJourneysBatch(ctx(), integrationId, 0, 100);
}

async function snapshot() {
  const [p, v, c, s, o, j, cy] = await Promise.all([
    prisma.product.count({ where: { organizationId: org.id } }),
    prisma.productVariant.count({ where: { organizationId: org.id } }),
    prisma.customer.count({ where: { organizationId: org.id } }),
    prisma.subscription.count({ where: { organizationId: org.id } }),
    prisma.subscriptionOrder.count({ where: { organizationId: org.id } }),
    prisma.subscriptionJourney.count({ where: { organizationId: org.id } }),
    prisma.journeyCycle.count({ where: { organizationId: org.id } }),
  ]);
  return { p, v, c, s, o, j, cy };
}

beforeAll(async () => {
  await prisma.organization.create({ data: org });
  const integ = await prisma.integration.create({ data: { organizationId: org.id, provider: "RECHARGE", externalStoreId: `s-${run}`, displayName: "Fake", encryptedCredentials: "x" } });
  integrationId = integ.id;
  const program = await prisma.subscriptionProgram.create({ data: { organizationId: org.id, name: "Morning Magic Powder" } });
  programId = program.id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: org.id } });
  await prisma.$disconnect();
});

describe("sync idempotency", () => {
  it("first run imports everything; products unmapped → subscriptions UNMAPPED, no journeys", async () => {
    await runAllStages();
    expect(await snapshot()).toEqual({ p: 2, v: 3, c: 2, s: 2, o: 4, j: 0, cy: 0 });
    const s123 = await prisma.subscription.findFirstOrThrow({ where: { organizationId: org.id, externalSubscriptionId: "123" } });
    expect(s123.mappingStatus).toBe("UNMAPPED");
    expect(s123.latestJourneyId).toBeNull();
    expect(s123.nextChargeDate).toBe("2026-09-21");
    expect(s123.productId).not.toBeNull(); // catalogue link exists even when unmapped
  });

  it("running the same import again changes nothing", async () => {
    const before = await snapshot();
    await runAllStages();
    expect(await snapshot()).toEqual(before);
  });

  it("mapping the product then recalculating produces exactly one journey with cycles 1..3 (variant change within program kept)", async () => {
    const mm = await prisma.product.findFirstOrThrow({ where: { organizationId: org.id, externalProductId: "8001" } });
    await prisma.subscriptionProgramProduct.create({ data: { organizationId: org.id, programId, productId: mm.id, variantId: null, variantScope: "*" } });
    await recalculateJourneysBatch(ctx(), integrationId, 0, 100);
    const s123 = await prisma.subscription.findFirstOrThrow({ where: { organizationId: org.id, externalSubscriptionId: "123" }, include: { latestJourney: { include: { cycles: { orderBy: { cycleNumber: "asc" } } } } } });
    expect(s123.mappingStatus).toBe("MAPPED");
    expect(s123.latestJourney?.successfulCycles).toBe(3);
    expect(s123.latestJourney?.cycles.map((c) => [c.cycleNumber, c.externalOrderId, c.orderKind])).toEqual([[1, "5001", "CHECKOUT"], [2, "5002", "RECURRING"], [3, "5003", "RECURRING"]]);
    const s124 = await prisma.subscription.findFirstOrThrow({ where: { organizationId: org.id, externalSubscriptionId: "124" } });
    expect(s124.mappingStatus).toBe("UNMAPPED");
    expect(await prisma.subscriptionJourney.count({ where: { organizationId: org.id } })).toBe(1);
  });

  it("re-running import + recalculation after mapping is still idempotent and keeps journey ids stable", async () => {
    const before = await snapshot();
    const j1 = await prisma.subscriptionJourney.findFirstOrThrow({ where: { organizationId: org.id } });
    await runAllStages();
    await runAllStages();
    expect(await snapshot()).toEqual(before);
    const j2 = await prisma.subscriptionJourney.findFirstOrThrow({ where: { organizationId: org.id } });
    expect(j2.id).toBe(j1.id);
  });

  it("a partial run (orders stage interrupted before journeys) converges on retry", async () => {
    // simulate: a new order arrives, import it, but "crash" before journeys
    const extra = mkOrder("5004", "2026-04-05", "123", "RECURRING");
    const fake2 = { ...fake, listOrders: () => onePage([...orders, extra]) } as unknown as RechargeConnector;
    await importOrdersPage(ctx(), fake2, integrationId, null);
    // journey still says 3 — stale but not wrong-duplicated
    let s123 = await prisma.subscription.findFirstOrThrow({ where: { organizationId: org.id, externalSubscriptionId: "123" }, include: { latestJourney: true } });
    expect(s123.latestJourney?.successfulCycles).toBe(3);
    // retry completes the pipeline
    await recalculateJourneysBatch(ctx(), integrationId, 0, 100);
    await recalculateJourneysBatch(ctx(), integrationId, 0, 100);
    s123 = await prisma.subscription.findFirstOrThrow({ where: { organizationId: org.id, externalSubscriptionId: "123" }, include: { latestJourney: true } });
    expect(s123.latestJourney?.successfulCycles).toBe(4);
    expect(await prisma.journeyCycle.count({ where: { organizationId: org.id } })).toBe(4);
  });

  it("a status change on re-import (active → cancelled) updates the same row and ends the journey", async () => {
    const cancelled = { ...subs[0], status: "cancelled" as const, providerStatus: "cancelled", cancelledAt: new Date("2026-05-01"), nextChargeDate: null };
    const fake3 = { ...fake, listSubscriptions: (o: { status: string }) => onePage(o.status === "cancelled" ? [cancelled] : o.status === "active" ? [subs[1]] : []) } as unknown as RechargeConnector;
    for (const status of ["active", "cancelled", "expired"] as const) await importSubscriptionsPage(ctx(), fake3, integrationId, status, null);
    await recalculateJourneysBatch(ctx(), integrationId, 0, 100);
    const s123 = await prisma.subscription.findFirstOrThrow({ where: { organizationId: org.id, externalSubscriptionId: "123" }, include: { latestJourney: true } });
    expect(s123.status).toBe("CANCELLED");
    expect(s123.latestJourney?.endReason).toBe("CANCELLED");
    expect(s123.latestJourney?.successfulCycles).toBe(4);
    expect(await prisma.subscription.count({ where: { organizationId: org.id } })).toBe(2);
  });
});

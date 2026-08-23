/**
 * Impact analysis against real DB rows:
 *  - PER_SUBSCRIPTION vs CUSTOMER_PROGRAM on the "Danielle" shape (cancelled 10 + new 2 = lifetime 12)
 *  - two simultaneous subscriptions in the same programme
 *  - no-upcoming-charge, cancelled, unmapped buckets
 *  - lifetime deliveries are counted from DISTINCT cycle evidence, not summed counters
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { analyzeMilestoneImpact } from "@/lib/domain/rules/impact";

const run = Math.random().toString(36).slice(2, 8);
const org = { id: `test_impact_${run}`, slug: `test-impact-${run}`, name: "Impact Test" };
let integrationId = "";
let programId = "";
let productId = "";
let variantId = "";

async function mkSub(opts: { ext: string; customerId: string; status: "ACTIVE" | "CANCELLED"; cycles: number; next: string | null; mapped?: boolean; ordersPrefix: string }) {
  const sub = await prisma.subscription.create({
    data: {
      organizationId: org.id, integrationId, customerId: opts.customerId, externalSubscriptionId: opts.ext, externalCustomerId: "c", externalAddressId: "a", status: opts.status, mappingStatus: opts.mapped === false ? "UNMAPPED" : "MAPPED",
      productId, variantId, externalProductId: "8001", externalVariantId: "9001", productTitleSnapshot: "MM", nextChargeDate: opts.next, nextChargeAt: opts.next ? new Date(opts.next) : null,
    },
  });
  if (opts.mapped === false) return sub;
  const j = await prisma.subscriptionJourney.create({ data: { organizationId: org.id, subscriptionId: sub.id, programId, productId, variantId, externalProductId: "8001", externalVariantId: "9001", sequence: 1, startedAt: new Date("2026-01-01"), endedAt: opts.status === "CANCELLED" ? new Date("2026-06-01") : null, endReason: opts.status === "CANCELLED" ? "CANCELLED" : null, successfulCycles: opts.cycles } });
  for (let c = 1; c <= opts.cycles; c++) {
    await prisma.journeyCycle.create({ data: { organizationId: org.id, journeyId: j.id, cycleNumber: c, externalOrderId: `${opts.ordersPrefix}-${c}`, orderKind: c === 1 ? "CHECKOUT" : "RECURRING", processedAt: new Date(2026, 0, c), source: "BACKFILL" } });
  }
  await prisma.subscription.update({ where: { id: sub.id }, data: { latestJourneyId: j.id } });
  return sub;
}

beforeAll(async () => {
  await prisma.organization.create({ data: org });
  const integ = await prisma.integration.create({ data: { organizationId: org.id, provider: "RECHARGE", externalStoreId: `s-${run}`, displayName: "Fake", encryptedCredentials: "x", automationMode: "OFF" } });
  integrationId = integ.id;
  const p = await prisma.product.create({ data: { organizationId: org.id, integrationId, externalProductId: "8001", title: "MM" } });
  productId = p.id;
  const v = await prisma.productVariant.create({ data: { organizationId: org.id, productId, externalVariantId: "9001", title: "1" } });
  variantId = v.id;
  const prog = await prisma.subscriptionProgram.create({ data: { organizationId: org.id, name: "Morning Magic Powder" } });
  programId = prog.id;
  await prisma.subscriptionProgramProduct.create({ data: { organizationId: org.id, programId, productId, variantId: null, variantScope: "*" } });
  const danielle = await prisma.customer.create({ data: { organizationId: org.id, integrationId, externalCustomerId: "dan", firstName: "Danielle", lastName: "H" } });
  const fresh = await prisma.customer.create({ data: { organizationId: org.id, integrationId, externalCustomerId: "new", firstName: "New", lastName: "Customer" } });
  const twin = await prisma.customer.create({ data: { organizationId: org.id, integrationId, externalCustomerId: "twin", firstName: "Two", lastName: "Subs" } });
  const paused = await prisma.customer.create({ data: { organizationId: org.id, integrationId, externalCustomerId: "pau", firstName: "No", lastName: "Charge" } });
  const future = await prisma.customer.create({ data: { organizationId: org.id, integrationId, externalCustomerId: "fut", firstName: "Future", lastName: "Only" } });
  const past = await prisma.customer.create({ data: { organizationId: org.id, integrationId, externalCustomerId: "pst", firstName: "Already", lastName: "Past" } });
  await mkSub({ ext: "D-old", customerId: danielle.id, status: "CANCELLED", cycles: 10, next: null, ordersPrefix: "dold" });
  await mkSub({ ext: "D-new", customerId: danielle.id, status: "ACTIVE", cycles: 1, next: "2026-09-01", ordersPrefix: "dnew" });
  await mkSub({ ext: "N-1", customerId: fresh.id, status: "ACTIVE", cycles: 1, next: "2026-09-02", ordersPrefix: "n" });
  await mkSub({ ext: "T-a", customerId: twin.id, status: "ACTIVE", cycles: 1, next: "2026-09-03", ordersPrefix: "ta" });
  await mkSub({ ext: "T-b", customerId: twin.id, status: "ACTIVE", cycles: 1, next: "2026-09-04", ordersPrefix: "tb" });
  await mkSub({ ext: "P-1", customerId: paused.id, status: "ACTIVE", cycles: 1, next: null, ordersPrefix: "p" });
  await mkSub({ ext: "U-1", customerId: fresh.id, status: "ACTIVE", cycles: 0, next: "2026-09-05", mapped: false, ordersPrefix: "u" });
  await mkSub({ ext: "F-1", customerId: future.id, status: "ACTIVE", cycles: 0, next: "2026-09-06", ordersPrefix: "f" });
  await mkSub({ ext: "X-1", customerId: past.id, status: "ACTIVE", cycles: 4, next: "2026-09-07", ordersPrefix: "x" });
});
afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: org.id } });
  await prisma.$disconnect();
});

describe("analyzeMilestoneImpact (cycle 2)", () => {
  it("classifies subscriptions and compares both scopes", async () => {
    const s = await analyzeMilestoneImpact({ organizationId: org.id }, { programId, cycleNumber: 2 });
    const row = (ext: string) => s.rows.find((r) => r.externalSubscriptionId === ext)!;
    // unmapped subs have no journey in this programme → not in the programme population at all
    expect(s.rows.map((r) => r.externalSubscriptionId).sort()).toEqual(["D-new", "D-old", "F-1", "N-1", "P-1", "T-a", "T-b", "X-1"]);
    expect(s.totalSubscriptions).toBe(8);
    expect(row("D-old").bucket).toBe("CANCELLED_OR_INACTIVE");
    expect(row("P-1").bucket).toBe("NO_UPCOMING_CHARGE");
    expect(row("F-1").bucket).toBe("FUTURE_ONLY");
    expect(row("X-1").bucket).toBe("ALREADY_PAST");
    expect(row("N-1").bucket).toBe("WOULD_QUALIFY_NOW");
    // Danielle: per-subscription qualifies, customer-programme does not (lifetime 11 → already past cycle 2)
    expect(row("D-new").lifetimeDeliveries).toBe(11);
    expect(row("D-new").otherJourneysInProgram).toBe(1);
    expect(row("D-new").perSubscription.qualifies).toBe(true);
    expect(row("D-new").customerProgram).toMatchObject({ qualifies: false, reason: "CUSTOMER_ALREADY_REACHED_MILESTONE" });
    // twin: two live subs at cycle 1 → lifetime 2 → customer-programme says milestone 2 already reached by the pair; per-subscription each qualifies
    expect(row("T-a").lifetimeDeliveries).toBe(2);
    expect(row("T-a").perSubscription.qualifies).toBe(true);
    expect(row("T-a").customerProgram).toMatchObject({ qualifies: false, reason: "CUSTOMER_ALREADY_REACHED_MILESTONE" });
    // summary numbers
    expect(s.perSubscription.qualifyNow).toBe(4); // D-new, N-1, T-a, T-b
    expect(s.customerProgram.qualifyNow).toBe(1); // N-1 only
    expect(s.customerProgram.alreadyReachedViaOtherSubscription).toBe(3);
    expect(s.scopeDifferences.map((r) => r.externalSubscriptionId).sort()).toEqual(["D-new", "T-a", "T-b"]);
    expect(s.buckets.WOULD_QUALIFY_NOW).toBe(4);
    expect(s.buckets.NO_UPCOMING_CHARGE).toBe(1);
    expect(s.buckets.CANCELLED_OR_INACTIVE).toBe(1);
  });

  it("lifetime deliveries come from distinct cycle evidence, not from summed counters", async () => {
    // corrupt a denormalised counter deliberately; lifetime must still be evidence-based
    const j = await prisma.subscriptionJourney.findFirstOrThrow({ where: { organizationId: org.id, subscription: { externalSubscriptionId: "D-old" } } });
    await prisma.subscriptionJourney.update({ where: { id: j.id }, data: { successfulCycles: 999 } });
    const s = await analyzeMilestoneImpact({ organizationId: org.id }, { programId, cycleNumber: 2 });
    expect(s.rows.find((r) => r.externalSubscriptionId === "D-new")!.lifetimeDeliveries).toBe(11);
    await prisma.subscriptionJourney.update({ where: { id: j.id }, data: { successfulCycles: 10 } });
  });

  it("a cycle-12 rule would fire for Danielle under CUSTOMER_PROGRAM but not PER_SUBSCRIPTION", async () => {
    const s = await analyzeMilestoneImpact({ organizationId: org.id }, { programId, cycleNumber: 12 });
    const d = s.rows.find((r) => r.externalSubscriptionId === "D-new")!;
    expect(d.customerProgram.qualifies).toBe(true);
    expect(d.perSubscription).toMatchObject({ qualifies: false, reason: "NOT_NEXT_CYCLE" });
  });
});

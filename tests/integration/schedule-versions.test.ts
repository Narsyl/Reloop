/**
 * Journey versions and repeating journeys, at the planner level against the real DB.
 * Proves: journeys resolve the schedule version in force when THEY started (existing
 * subscribers keep their promised gifts when a new version arrives, new journeys get the
 * new gifts); a version's arrival never cancels or supersedes grandfathered actions; a
 * repeating schedule loops with real delivery numbers, treats the first position as a
 * checkout gift on lap one only, and plans it as a renewal gift on later laps.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { planActionsForIntegration } from "@/lib/domain/actions/planner";
import { assignProgramSchedule, assignProgramScheduleVersion, setRewardScheduleStatus, upsertMilestone, upsertRewardItem, upsertRewardSchedule } from "@/lib/domain/rewards/core";
import { effectiveMilestoneForCycle, resolveProgramRewards } from "@/lib/domain/rewards/resolver";
import { recalculateJourneysForSubscriptions } from "@/lib/domain/journeys/recalc";

const run = Math.random().toString(36).slice(2, 8);
const org = { id: `test_sv_${run}`, slug: `test-sv-${run}`, name: "Schedule Versions", timezone: "Europe/London", markerLeadHours: 72 };
const ctx = { organizationId: org.id, userId: null };
const NOW = new Date("2026-09-16T12:00:00Z");
const CUTOFF = new Date("2026-09-10T00:00:00Z");

let integrationId = "";
let progId = "";
let giftA = "";
let giftB = "";
let schedV1 = "";
let schedV2 = "";

function ok<T>(r: { ok: true; data?: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.data as T;
}
const plan = () => planActionsForIntegration(ctx, integrationId, { trigger: "TEST", now: NOW });
const actionsFor = (ext: string) =>
  prisma.automationAction.findMany({ where: { organizationId: org.id, subscription: { externalSubscriptionId: ext }, status: { in: ["PLANNED", "EXECUTING", "ATTACHED"] } }, include: { rewardItem: { select: { name: true } } }, orderBy: { targetCycle: "asc" } });

async function seedSub(ext: string, opts: { created: Date; orders: Date[]; next?: string }) {
  const customer = await prisma.customer.upsert({ where: { integrationId_externalCustomerId: { integrationId, externalCustomerId: `c-${ext}` } }, create: { organizationId: org.id, integrationId, externalCustomerId: `c-${ext}`, firstName: ext, lastName: "Test", email: `${ext}@example.com` }, update: {} });
  const sub = await prisma.subscription.create({
    data: { organizationId: org.id, integrationId, customerId: customer.id, externalSubscriptionId: ext, externalCustomerId: `c-${ext}`, externalAddressId: `addr-${ext}`, status: "ACTIVE", externalProductId: "910100", externalVariantId: "910101", productTitleSnapshot: "Shilajit", nextChargeDate: opts.next ?? "2026-10-05", externalCreatedAt: opts.created },
  });
  for (let i = 0; i < opts.orders.length; i++) {
    await prisma.subscriptionOrder.create({ data: { organizationId: org.id, integrationId, subscriptionId: sub.id, externalSubscriptionId: ext, externalOrderId: `${ext}-o${i + 1}`, externalCustomerId: `c-${ext}`, externalAddressId: `addr-${ext}`, orderKind: i === 0 ? "CHECKOUT" : "RECURRING", orderStatus: "success", processedAt: opts.orders[i], externalProductId: "910100", externalVariantId: "910101", productTitle: "Shilajit" } });
  }
  await recalculateJourneysForSubscriptions(ctx, integrationId, [sub.id], NOW);
  return sub;
}

beforeAll(async () => {
  await prisma.organization.create({ data: org });
  integrationId = (await prisma.integration.create({ data: { organizationId: org.id, provider: "RECHARGE", externalStoreId: `sv-${run}`, displayName: "SV Store", encryptedCredentials: "x", automationMode: "DRY_RUN", status: "CONNECTED" } })).id;
  const prod = await prisma.product.create({ data: { organizationId: org.id, integrationId, externalProductId: "910100", title: "Shilajit" } });
  await prisma.productVariant.create({ data: { organizationId: org.id, productId: prod.id, externalVariantId: "910101", title: "30g" } });
  progId = (await prisma.subscriptionProgram.create({ data: { organizationId: org.id, name: "Shilajit" } })).id;
  await prisma.subscriptionProgramProduct.create({ data: { organizationId: org.id, programId: progId, productId: prod.id, variantId: null, variantScope: "*" } });
  giftA = ok(await upsertRewardItem(ctx, { name: "Gift A" })).id;
  giftB = ok(await upsertRewardItem(ctx, { name: "Gift B" })).id;
  const shopifyId = (await prisma.integration.create({ data: { organizationId: org.id, provider: "SHOPIFY", externalStoreId: `svshp-${run}.myshopify.com`, displayName: "Shopify", encryptedCredentials: "x", automationMode: "OFF", pairedIntegrationId: integrationId } })).id;
  for (const [item, variant] of [[giftA, "920101"], [giftB, "920201"]] as const) {
    await prisma.rewardItemExternalBinding.create({ data: { organizationId: org.id, rewardItemId: item, integrationId: shopifyId, provider: "SHOPIFY", externalProductId: variant.slice(0, 4) + "0", externalVariantId: variant, externalTitle: `Bound ${variant}`, externalStatus: "ACTIVE", requiresShipping: true, rechargeCompatibility: "VERIFIED", verificationJson: { issues: [] } } });
  }
  // V1: Gift A with the 2nd delivery. Baseline for the programme.
  schedV1 = ok(await upsertRewardSchedule(ctx, { name: "SV v1" })).id;
  ok(await upsertMilestone(ctx, { scheduleId: schedV1, cycleNumber: 2, rewardItemId: giftA, eligibilityScope: "PER_SUBSCRIPTION" }));
  ok(await setRewardScheduleStatus(ctx, schedV1, "READY"));
  ok(await assignProgramSchedule(ctx, { programId: progId, scheduleId: schedV1 }));
  // V2: repeating, Gift B at 1 (checkout) then Gift A at 2, looping.
  schedV2 = ok(await upsertRewardSchedule(ctx, { name: "SV v2", repeats: true })).id;
  ok(await upsertMilestone(ctx, { scheduleId: schedV2, cycleNumber: 1, rewardItemId: giftB, eligibilityScope: "PER_SUBSCRIPTION" }));
  ok(await upsertMilestone(ctx, { scheduleId: schedV2, cycleNumber: 2, rewardItemId: giftA, eligibilityScope: "PER_SUBSCRIPTION" }));
  ok(await setRewardScheduleStatus(ctx, schedV2, "READY"));
});
afterAll(async () => {
  await prisma.organization.delete({ where: { id: org.id } });
  await prisma.$disconnect();
});

describe("journey versions", () => {
  it("plans v1 gifts for a journey started before the cutoff, then keeps them after v2 arrives", async () => {
    await seedSub("SV-OLD", { created: new Date("2026-08-01T09:00:00Z"), orders: [new Date("2026-08-01T10:00:00Z")] });
    let s = await plan();
    expect(s.planned).toBe(1);
    const before = await actionsFor("SV-OLD");
    expect(before).toHaveLength(1);
    expect(before[0].rewardItem?.name).toBe("Gift A");
    expect(before[0].targetCycle).toBe(2);

    ok(await assignProgramScheduleVersion(ctx, { programId: progId, scheduleId: schedV2, effectiveFrom: CUTOFF }));
    s = await plan();
    expect(s.cancelled).toBe(0);
    expect(s.superseded).toBe(0);
    const after = await actionsFor("SV-OLD");
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].rewardItem?.name).toBe("Gift A");
  });

  it("a journey started after the cutoff follows v2: no lap one checkout gift planned, delivery 2 gets its gift", async () => {
    await seedSub("SV-NEW", { created: new Date("2026-09-12T09:00:00Z"), orders: [new Date("2026-09-12T10:00:00Z")] });
    await plan();
    const acts = await actionsFor("SV-NEW");
    expect(acts).toHaveLength(1);
    expect(acts[0].rewardItem?.name).toBe("Gift A"); // v2 delivery 2
    expect(acts[0].targetCycle).toBe(2);
  });

  it("the config view shows v2 for new subscribers while the old journey still resolves v1", async () => {
    const current = await resolveProgramRewards(ctx, progId);
    expect(current.schedule?.name).toBe("SV v2");
    expect(current.schedule?.repeats).toBe(true);
    const old = await resolveProgramRewards(ctx, progId, { journeyStartedAt: new Date("2026-08-01T10:00:00Z") });
    expect(old.schedule?.name).toBe("SV v1");
  });
});

describe("repeating journeys", () => {
  it("wraps the sequence with real delivery numbers and converts the checkout position to a renewal gift on later laps", async () => {
    const view = await resolveProgramRewards(ctx, progId);
    const d3 = effectiveMilestoneForCycle(view, 3); // lap 2, position 1 (Gift B, checkout on lap 1)
    expect(d3?.rewardItem.name).toBe("Gift B");
    expect(d3?.cycleNumber).toBe(3);
    expect(d3?.executionMode).toBe("UPCOMING_RENEWAL");
    expect(d3?.readiness).toBe("READY");
    const d4 = effectiveMilestoneForCycle(view, 4);
    expect(d4?.rewardItem.name).toBe("Gift A");
    const d1 = effectiveMilestoneForCycle(view, 1); // lap 1 checkout position stays unplannable
    expect(d1?.executionMode).toBe("INITIAL_CHECKOUT");
    expect(d1?.readiness).not.toBe("READY");
  });

  it("the planner gifts lap two: a post cutoff journey at 2 deliveries gets the position 1 gift on delivery 3", async () => {
    await seedSub("SV-LAP", { created: new Date("2026-09-11T09:00:00Z"), orders: [new Date("2026-09-11T10:00:00Z"), new Date("2026-09-14T10:00:00Z")] });
    await plan();
    const acts = await actionsFor("SV-LAP");
    expect(acts).toHaveLength(1);
    expect(acts[0].targetCycle).toBe(3);
    expect(acts[0].rewardItem?.name).toBe("Gift B");
  });

  it("a repeating schedule with gaps or customer scoped milestones cannot take subscribers", async () => {
    const gappy = ok(await upsertRewardSchedule(ctx, { name: "SV gaps", repeats: true })).id;
    ok(await upsertMilestone(ctx, { scheduleId: gappy, cycleNumber: 2, rewardItemId: giftA, eligibilityScope: "PER_SUBSCRIPTION" }));
    ok(await setRewardScheduleStatus(ctx, gappy, "READY"));
    const r = await assignProgramScheduleVersion(ctx, { programId: progId, scheduleId: gappy });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/no gaps/);
  });
});

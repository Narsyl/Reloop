/**
 * Phase 4 / 4b — action planner on REWARD SCHEDULES + DRY_RUN executor, against real DB rows.
 *
 * Fixtures are built from SubscriptionOrder facts and the REAL journey recalculation, so the
 * "sync → recalc → planner stays idempotent" case is genuine, and lifecycle counts are fingerprinted
 * before/after every planner run.
 *
 *   Schedule A (shared by programmes MM and Chaga): delivery 2 → Whisk, delivery 3 → Cup (CUSTOMER_PROGRAM)
 *   Schedule B (programme EE):                      delivery 1 → Whisk (INITIAL_CHECKOUT), 2 → Cup
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { recalculateJourneysForSubscriptions } from "@/lib/domain/journeys/recalc";
import { planActionsForIntegration } from "@/lib/domain/actions/planner";
import { dryRunAction } from "@/lib/domain/actions/dry-run";
import { setIntegrationAutomationMode } from "@/lib/domain/actions/mode";
import { analyzeMilestoneImpact } from "@/lib/domain/rules/impact";
import { resolveProgramRewards } from "@/lib/domain/rewards/resolver";
import { assignProgramSchedule, bindProgramMarker, setRewardScheduleStatus, upsertMilestone, upsertRewardItem, upsertRewardSchedule } from "@/lib/domain/rewards/core";
import { localMidnightUtc } from "@/lib/domain/time";
import type { ConnectorOnetime, ConnectorSubscription } from "@/lib/integrations/types";

const run = Math.random().toString(36).slice(2, 8);
const org = { id: `test_plan_${run}`, slug: `test-plan-${run}`, name: "Planner Test", timezone: "Europe/London", markerLeadHours: 72 };
const ctx = { organizationId: org.id };
let integrationId = "";
let progMM = "";
let progB = "";
let progEE = "";
let whisk = "";
let cup = "";
let schedA = "";
let schedB = "";
let msA2 = "";
let msA3 = "";
let msB1 = "";
let msB2 = "";
let markerMM2 = "";
let markerMM2alt = "";
let markerB2 = "";
let markerEE2 = "";
let markerPlaceholder = "";
let markerCupOnly = "";
const subIds: Record<string, string> = {};
const NOW = new Date("2026-08-23T15:00:00Z");

const MM_PRODUCT = "8001", MM_VARIANT = "9001", B_PRODUCT = "8002", B_VARIANT = "9002", EE_PRODUCT = "8003", EE_VARIANT = "9003";

async function mkCustomer(ext: string, name: string) {
  return prisma.customer.create({ data: { organizationId: org.id, integrationId, externalCustomerId: ext, firstName: name, lastName: "Test", email: `${ext}@example.com` } });
}
async function mkSub(opts: { ext: string; customerId: string; externalCustomerId: string; status?: "ACTIVE" | "CANCELLED"; orders: number; next: string | null; product?: string; variant?: string; historyProduct?: string; historyVariant?: string; historyOrders?: number }) {
  const product = opts.product ?? MM_PRODUCT;
  const variant = opts.variant ?? MM_VARIANT;
  const sub = await prisma.subscription.create({
    data: { organizationId: org.id, integrationId, customerId: opts.customerId, externalSubscriptionId: opts.ext, externalCustomerId: opts.externalCustomerId, externalAddressId: `addr-${opts.ext}`, status: opts.status ?? "ACTIVE", externalProductId: product, externalVariantId: variant, productTitleSnapshot: "x", nextChargeDate: opts.next, nextChargeAt: opts.next ? localMidnightUtc(opts.next, org.timezone) : null, externalCreatedAt: new Date("2026-01-01") },
  });
  subIds[opts.ext] = sub.id;
  let n = 0;
  const mkOrder = async (prod: string, vari: string, kind: "CHECKOUT" | "RECURRING") => {
    n++;
    await prisma.subscriptionOrder.create({ data: { organizationId: org.id, integrationId, subscriptionId: sub.id, externalSubscriptionId: opts.ext, externalOrderId: `${opts.ext}-o${n}`, externalCustomerId: opts.externalCustomerId, externalAddressId: `addr-${opts.ext}`, orderKind: kind, orderStatus: "success", processedAt: new Date(Date.UTC(2026, 0, n, 9)), externalProductId: prod, externalVariantId: vari, productTitle: "x" } });
  };
  for (let i = 0; i < (opts.historyOrders ?? 0); i++) await mkOrder(opts.historyProduct ?? B_PRODUCT, opts.historyVariant ?? B_VARIANT, i === 0 ? "CHECKOUT" : "RECURRING");
  for (let i = 0; i < opts.orders; i++) await mkOrder(product, variant, i === 0 && !(opts.historyOrders ?? 0) ? "CHECKOUT" : "RECURRING");
  return sub;
}
async function recalcAll() {
  const ids = await prisma.subscription.findMany({ where: { organizationId: org.id }, select: { id: true } });
  await recalculateJourneysForSubscriptions(ctx, integrationId, ids.map((s) => s.id), NOW);
}
async function fingerprint() {
  const js = await prisma.subscriptionJourney.findMany({ where: { organizationId: org.id }, include: { cycles: true }, orderBy: { id: "asc" } });
  return js.map((j) => `${j.subscriptionId}|${j.sequence}|${j.programId}|${j.successfulCycles}|${j.cycles.map((c) => c.externalOrderId).sort().join(",")}`).join("\n");
}
const liveActions = () => prisma.automationAction.findMany({ where: { organizationId: org.id, status: "PLANNED" }, include: { subscription: { select: { externalSubscriptionId: true } } }, orderBy: { createdAt: "asc" } });
const allActions = () => prisma.automationAction.findMany({ where: { organizationId: org.id }, include: { subscription: { select: { externalSubscriptionId: true } } }, orderBy: { createdAt: "asc" } });
const plan = (o: Partial<Parameters<typeof planActionsForIntegration>[2]> = {}) => planActionsForIntegration(ctx, integrationId, { trigger: "TEST", now: NOW, ...o });
function ok<T>(r: { ok: true; data?: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.data as T;
}

beforeAll(async () => {
  await prisma.organization.create({ data: org });
  const integ = await prisma.integration.create({ data: { organizationId: org.id, provider: "RECHARGE", externalStoreId: `s-${run}`, displayName: "Fake Store", encryptedCredentials: "x", automationMode: "DRY_RUN", status: "CONNECTED" } });
  integrationId = integ.id;
  const mkProduct = async (ext: string, variant: string, title: string) => {
    const p = await prisma.product.create({ data: { organizationId: org.id, integrationId, externalProductId: ext, title } });
    await prisma.productVariant.create({ data: { organizationId: org.id, productId: p.id, externalVariantId: variant, title: "1" } });
    return p;
  };
  const pMM = await mkProduct(MM_PRODUCT, MM_VARIANT, "Morning Magic");
  const pB = await mkProduct(B_PRODUCT, B_VARIANT, "Chaga");
  const pEE = await mkProduct(EE_PRODUCT, EE_VARIANT, "Evening Elixir");
  const mkProgram = async (name: string, productId: string) => {
    const prog = await prisma.subscriptionProgram.create({ data: { organizationId: org.id, name } });
    await prisma.subscriptionProgramProduct.create({ data: { organizationId: org.id, programId: prog.id, productId, variantId: null, variantScope: "*" } });
    return prog.id;
  };
  progMM = await mkProgram("Morning Magic Powder", pMM.id);
  progB = await mkProgram("Chaga", pB.id);
  progEE = await mkProgram("Evening Elixir", pEE.id);

  whisk = ok(await upsertRewardItem(ctx, { name: "Whisk", operationalDescription: "Include whisk" })).id;
  cup = ok(await upsertRewardItem(ctx, { name: "Cup", operationalDescription: "Include cup" })).id;
  const mk = async (name: string, variant: string, rewardItemId: string | null, placeholder = false) => {
    const prod = await prisma.product.create({ data: { organizationId: org.id, integrationId, externalProductId: `mk-${variant}`, title: name, type: "FULFILMENT_MARKER" } });
    const v = await prisma.productVariant.create({ data: { organizationId: org.id, productId: prod.id, externalVariantId: variant, title: name, sku: `SKU-${variant}`, price: "0.00" } });
    return (await prisma.fulfillmentMarker.create({ data: { organizationId: org.id, integrationId, name, variantId: v.id, externalVariantId: variant, externalProductId: `mk-${variant}`, title: name, sku: `SKU-${variant}`, source: "MANUAL", placeholder, rewardItemId } })).id;
  };
  markerMM2 = await mk("Morning Magic 2", "77001", whisk);
  markerMM2alt = await mk("Morning Magic 2 (alt)", "77002", whisk);
  markerB2 = await mk("Chaga 2", "77003", whisk);
  markerEE2 = await mk("Evening Elixir 2", "77004", cup);
  markerPlaceholder = await mk("PLACEHOLDER", "77005", whisk, true);
  markerCupOnly = await mk("Cup only", "77006", cup);

  schedA = ok(await upsertRewardSchedule(ctx, { name: "Schedule A" })).id;
  msA2 = ok(await upsertMilestone(ctx, { scheduleId: schedA, cycleNumber: 2, rewardItemId: whisk, eligibilityScope: "CUSTOMER_PROGRAM" })).id;
  msA3 = ok(await upsertMilestone(ctx, { scheduleId: schedA, cycleNumber: 3, rewardItemId: cup, eligibilityScope: "CUSTOMER_PROGRAM" })).id;
  schedB = ok(await upsertRewardSchedule(ctx, { name: "Schedule B" })).id;
  msB1 = ok(await upsertMilestone(ctx, { scheduleId: schedB, cycleNumber: 1, rewardItemId: whisk, eligibilityScope: "CUSTOMER_PROGRAM" })).id;
  msB2 = ok(await upsertMilestone(ctx, { scheduleId: schedB, cycleNumber: 2, rewardItemId: cup, eligibilityScope: "CUSTOMER_PROGRAM" })).id;
  ok(await assignProgramSchedule(ctx, { programId: progMM, scheduleId: schedA }));
  ok(await assignProgramSchedule(ctx, { programId: progB, scheduleId: schedA }));
  ok(await assignProgramSchedule(ctx, { programId: progEE, scheduleId: schedB }));
  ok(await bindProgramMarker(ctx, { programId: progMM, milestoneId: msA2, fulfillmentMarkerId: markerMM2 }));
  ok(await bindProgramMarker(ctx, { programId: progB, milestoneId: msA2, fulfillmentMarkerId: markerB2 }));
  ok(await bindProgramMarker(ctx, { programId: progEE, milestoneId: msB2, fulfillmentMarkerId: markerEE2 }));
  ok(await setRewardScheduleStatus(ctx, schedA, "READY"));
  ok(await setRewardScheduleStatus(ctx, schedB, "READY"));

  const fresh = await mkCustomer("c-fresh", "Fresh");
  const stuart = await mkCustomer("c-stuart", "Stuart");
  const ret = await mkCustomer("c-ret", "Returning");
  const nocharge = await mkCustomer("c-nocharge", "NoCharge");
  const canc = await mkCustomer("c-canc", "Cancelled");
  const moved = await mkCustomer("c-moved", "Moved");
  const danielle = await mkCustomer("c-dan", "Danielle");
  const twin = await mkCustomer("c-twin", "Twin");
  const future = await mkCustomer("c-future", "Future");
  const both = await mkCustomer("c-both", "BothProgrammes");
  const ee = await mkCustomer("c-ee", "EveningElixir");
  await mkSub({ ext: "N-1", customerId: fresh.id, externalCustomerId: "c-fresh", orders: 1, next: "2026-09-02" });
  await mkSub({ ext: "S-old", customerId: stuart.id, externalCustomerId: "c-stuart", status: "CANCELLED", orders: 3, next: null });
  await mkSub({ ext: "S-new", customerId: stuart.id, externalCustomerId: "c-stuart", orders: 0, next: "2026-10-17" });
  await mkSub({ ext: "R-old", customerId: ret.id, externalCustomerId: "c-ret", status: "CANCELLED", orders: 1, next: null });
  await mkSub({ ext: "R-new", customerId: ret.id, externalCustomerId: "c-ret", orders: 1, next: "2026-09-05" });
  await mkSub({ ext: "NC-1", customerId: nocharge.id, externalCustomerId: "c-nocharge", orders: 1, next: null });
  await mkSub({ ext: "X-1", customerId: canc.id, externalCustomerId: "c-canc", status: "CANCELLED", orders: 1, next: "2026-09-09" });
  await mkSub({ ext: "MV-1", customerId: moved.id, externalCustomerId: "c-moved", orders: 1, next: "2026-09-12", product: B_PRODUCT, variant: B_VARIANT, historyProduct: MM_PRODUCT, historyVariant: MM_VARIANT, historyOrders: 1 });
  await mkSub({ ext: "D-old", customerId: danielle.id, externalCustomerId: "c-dan", status: "CANCELLED", orders: 10, next: null });
  await mkSub({ ext: "D-new", customerId: danielle.id, externalCustomerId: "c-dan", orders: 2, next: "2026-08-31" });
  await mkSub({ ext: "T-a", customerId: twin.id, externalCustomerId: "c-twin", orders: 1, next: "2026-09-03" });
  await mkSub({ ext: "T-b", customerId: twin.id, externalCustomerId: "c-twin", orders: 1, next: "2026-09-04" });
  await mkSub({ ext: "F-1", customerId: future.id, externalCustomerId: "c-future", orders: 0, next: "2026-09-06" });
  await mkSub({ ext: "BO-mm", customerId: both.id, externalCustomerId: "c-both", orders: 1, next: "2026-09-14" });
  await mkSub({ ext: "BO-b", customerId: both.id, externalCustomerId: "c-both", orders: 1, next: "2026-09-15", product: B_PRODUCT, variant: B_VARIANT });
  await mkSub({ ext: "EE-0", customerId: ee.id, externalCustomerId: "c-ee", orders: 0, next: "2026-09-20", product: EE_PRODUCT, variant: EE_VARIANT });
  await mkSub({ ext: "EE-1", customerId: ee.id, externalCustomerId: "c-ee", orders: 1, next: "2026-09-21", product: EE_PRODUCT, variant: EE_VARIANT });
  await recalcAll();
}, 240_000);
afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: org.id } });
  await prisma.$disconnect();
});

describe("effective milestone resolver", () => {
  it("reports readiness per programme and milestone; INITIAL_CHECKOUT is never plannable", async () => {
    const mm = await resolveProgramRewards(ctx, progMM);
    expect(mm.schedule?.name).toBe("Schedule A");
    expect(mm.milestones.map((m) => [m.cycleNumber, m.readiness])).toEqual([[2, "READY"], [3, "BINDING_MISSING"]]);
    const eeView = await resolveProgramRewards(ctx, progEE);
    expect(eeView.milestones.map((m) => [m.cycleNumber, m.executionMode, m.readiness])).toEqual([[1, "INITIAL_CHECKOUT", "INITIAL_CHECKOUT_NOT_PLANNED"], [2, "UPCOMING_RENEWAL", "READY"]]);
  });
  it("refuses bindings whose marker represents a different reward item or whose programme is on another schedule", async () => {
    expect((await bindProgramMarker(ctx, { programId: progMM, milestoneId: msA3, fulfillmentMarkerId: markerB2 })).ok).toBe(false); // A3 = cup, marker = whisk
    expect((await bindProgramMarker(ctx, { programId: progB, milestoneId: msA3, fulfillmentMarkerId: markerCupOnly })).ok).toBe(true);
    ok(await bindProgramMarker(ctx, { programId: progB, milestoneId: msA3, fulfillmentMarkerId: null }));
    expect((await bindProgramMarker(ctx, { programId: progEE, milestoneId: msA2, fulfillmentMarkerId: markerEE2 })).ok).toBe(false); // EE is not on Schedule A
  });
});

describe("planner (schedules)", () => {
  let fpBefore = "";
  it("plans one action per eligible milestone per programme, matches the impact analysis, never plans INITIAL_CHECKOUT, and rewards per programme", async () => {
    fpBefore = await fingerprint();
    const impactMM = await analyzeMilestoneImpact(ctx, { programId: progMM, cycleNumber: 2 });
    const impactNow = impactMM.rows.filter((r) => r.eligibility.eligible && r.customerProgram.qualifies).map((r) => r.externalSubscriptionId).sort();
    expect(impactNow).toEqual(["BO-mm", "N-1"]);

    const s = await plan();
    expect(s.skippedReason).toBeUndefined();
    expect(s.programsConsidered).toBe(3);
    const live = await liveActions();
    expect(live.map((a) => a.subscription.externalSubscriptionId).sort()).toEqual(["BO-b", "BO-mm", "EE-1", "MV-1", "N-1"]);
    expect(s.planned).toBe(5);
    expect(s.milestonesSkipped.map((m) => `${m.programName}:${m.cycleNumber}:${m.reason}`).sort()).toEqual(["Chaga:3:BINDING_MISSING", "Evening Elixir:1:INITIAL_CHECKOUT_NOT_PLANNED", "Morning Magic Powder:3:BINDING_MISSING"]);
    const mmPlanned = s.decisions.filter((d) => d.milestoneId === msA2 && d.programId === progMM && d.outcome === "PLANNED").map((d) => d.externalSubscriptionId).sort();
    expect(mmPlanned).toEqual(impactNow);
    const reason = (ext: string) => s.decisions.find((d) => d.milestoneId === msA2 && d.programId === progMM && d.externalSubscriptionId === ext)?.reason;
    expect(reason("S-new")).toBe("CUSTOMER_ALREADY_REACHED_MILESTONE");
    expect(reason("R-new")).toBe("CUSTOMER_ALREADY_REACHED_MILESTONE");
    expect(reason("NC-1")).toBe("NO_UPCOMING_CHARGE");
    expect(reason("X-1")).toBe("SUBSCRIPTION_NOT_ACTIVE");
    expect(reason("D-new")).toBe("MILESTONE_ALREADY_PASSED");
    expect(reason("T-a")).toBe("CUSTOMER_ALREADY_REACHED_MILESTONE");
    expect(reason("F-1")).toBe("NOT_NEXT_CYCLE");
    expect(s.decisions.find((d) => d.programId === progMM && d.externalSubscriptionId === "MV-1")).toBeUndefined();
    // EE-0 (0 deliveries) shares the customer with EE-1. A subscription's first shipment is never a renewal, so the
    // customer's delivery-2 cup lands deterministically on EE-1 (the journey at a renewal); EE-0 is future-only.
    const ee0 = s.decisions.find((d) => d.milestoneId === msB2 && d.externalSubscriptionId === "EE-0")!;
    expect(ee0.outcome).toBe("NOT_QUALIFIED");
    expect(ee0.reason).toBe("NOT_NEXT_CYCLE");
    expect(await prisma.automationAction.count({ where: { rewardScheduleMilestoneId: msB2, status: "PLANNED" } })).toBe(1);
    expect(await prisma.automationAction.count({ where: { rewardScheduleMilestoneId: msB1 } })).toBe(0);

    const a = live.find((x) => x.subscription.externalSubscriptionId === "N-1")!;
    expect(a.targetCycle).toBe(2);
    expect(a.targetChargeDate).toBe("2026-09-02");
    expect(a.targetChargeAt?.toISOString()).toBe(localMidnightUtc("2026-09-02", "Europe/London").toISOString());
    expect(a.executeAfter?.toISOString()).toBe(new Date(localMidnightUtc("2026-09-02", "Europe/London").getTime() - 72 * 3_600_000).toISOString());
    expect(a.eligibilityScope).toBe("CUSTOMER_PROGRAM");
    expect(a.rewardScheduleMilestoneId).toBe(msA2);
    expect(a.programId).toBe(progMM);
    expect(a.ruleId).toBeNull();
    expect(a.fulfillmentMarkerId).toBe(markerMM2);
    expect(a.liveKey).toBe(`${a.journeyId}:2:${markerMM2}`);
    expect(a.ownerKey).toMatch(/^c:.+:2:/);
    const bo = live.filter((x) => x.subscription.externalSubscriptionId.startsWith("BO-"));
    expect(bo.length).toBe(2);
    expect(new Set(bo.map((x) => x.programId)).size).toBe(2);
  }, 180_000);

  it("re-running repeatedly creates no duplicates", async () => {
    const before = (await allActions()).length;
    const s1 = await plan();
    const s2 = await plan();
    expect(s1.planned + s2.planned).toBe(0);
    expect(s1.confirmed).toBe(5);
    expect((await allActions()).length).toBe(before);
  }, 180_000);

  it("concurrent planner runs create exactly one action for a new milestone", async () => {
    const c = await mkCustomer("c-conc", "Concurrent");
    await mkSub({ ext: "CC-1", customerId: c.id, externalCustomerId: "c-conc", orders: 1, next: "2026-09-15" });
    await recalcAll();
    const results = await Promise.all(Array.from({ length: 5 }, () => plan()));
    expect(results.reduce((n, r) => n + r.planned, 0)).toBe(1);
    expect((await prisma.automationAction.findMany({ where: { organizationId: org.id, subscription: { externalSubscriptionId: "CC-1" } } })).length).toBe(1);
  }, 180_000);

  it("incremental sync (recalculation) followed by the planner stays idempotent and leaves lifecycle counts unchanged", async () => {
    const before = (await allActions()).map((a) => a.id).sort();
    const fp1 = await fingerprint();
    await recalcAll();
    const s = await plan();
    expect(s.planned).toBe(0);
    expect((await allActions()).map((a) => a.id).sort()).toEqual(before);
    expect(await fingerprint()).toBe(fp1);
    expect(fp1.split("\n").length).toBe(fpBefore.split("\n").length + 1);
  }, 180_000);

  it("replans in place when the target charge moves, cancels with a reason when it disappears", async () => {
    const n1 = (await liveActions()).find((a) => a.subscription.externalSubscriptionId === "N-1")!;
    await prisma.subscription.update({ where: { id: subIds["N-1"] }, data: { nextChargeDate: "2026-09-10", nextChargeAt: localMidnightUtc("2026-09-10", org.timezone) } });
    let s = await plan();
    expect(s.replanned).toBe(1);
    const moved = await prisma.automationAction.findUniqueOrThrow({ where: { id: n1.id } });
    expect(moved.targetChargeDate).toBe("2026-09-10");
    expect(moved.replanCount).toBe(1);
    await prisma.subscription.update({ where: { id: subIds["N-1"] }, data: { nextChargeDate: null, nextChargeAt: null } });
    s = await plan();
    expect(s.cancelledActions.some((c) => c.actionId === n1.id && c.reason === "NO_UPCOMING_CHARGE")).toBe(true);
    const cancelled = await prisma.automationAction.findUniqueOrThrow({ where: { id: n1.id } });
    expect(cancelled.liveKey).toBeNull();
    expect(cancelled.ownerKey).toBeNull();
    await prisma.subscription.update({ where: { id: subIds["N-1"] }, data: { nextChargeDate: "2026-09-12", nextChargeAt: localMidnightUtc("2026-09-12", org.timezone) } });
    s = await plan();
    expect(s.planned).toBe(1);
    expect((await prisma.automationAction.findMany({ where: { subscriptionId: subIds["N-1"], status: "PLANNED" } })).length).toBe(1);
  }, 180_000);

  it("supersedes when the programme's marker binding changes; a schedule swap keeps the physical keys (no duplicate)", async () => {
    ok(await bindProgramMarker(ctx, { programId: progMM, milestoneId: msA2, fulfillmentMarkerId: markerMM2alt }));
    let s = await plan();
    expect(s.superseded).toBeGreaterThanOrEqual(1);
    const n1 = await prisma.automationAction.findMany({ where: { subscriptionId: subIds["N-1"] }, orderBy: { createdAt: "asc" } });
    const sup = n1.find((a) => a.status === "SUPERSEDED")!;
    const live = n1.find((a) => a.status === "PLANNED")!;
    expect(sup.supersededById).toBe(live.id);
    expect(live.fulfillmentMarkerId).toBe(markerMM2alt);
    ok(await bindProgramMarker(ctx, { programId: progMM, milestoneId: msA2, fulfillmentMarkerId: markerMM2 }));
    await plan();

    const schedA2 = ok(await upsertRewardSchedule(ctx, { name: "Schedule A prime" })).id;
    const msA2b = ok(await upsertMilestone(ctx, { scheduleId: schedA2, cycleNumber: 2, rewardItemId: whisk, eligibilityScope: "CUSTOMER_PROGRAM" })).id;
    ok(await setRewardScheduleStatus(ctx, schedA2, "READY"));
    ok(await assignProgramSchedule(ctx, { programId: progMM, scheduleId: schedA2 }));
    ok(await bindProgramMarker(ctx, { programId: progMM, milestoneId: msA2b, fulfillmentMarkerId: markerMM2 }));
    const before = await prisma.automationAction.count({ where: { programId: progMM, status: "PLANNED" } });
    s = await plan();
    expect(s.planned).toBe(0);
    expect(await prisma.automationAction.count({ where: { programId: progMM, status: "PLANNED" } })).toBe(before);
    ok(await assignProgramSchedule(ctx, { programId: progMM, scheduleId: schedA }));
    await plan();
  }, 240_000);

  it("schedule back to DRAFT cancels with SCHEDULE_NOT_READY; automation OFF does nothing; LIVE refused; placeholder binding never planned", async () => {
    ok(await setRewardScheduleStatus(ctx, schedB, "DRAFT"));
    let s = await plan();
    expect(s.cancelledActions.some((c) => c.reason === "SCHEDULE_NOT_READY")).toBe(true);
    expect(await prisma.automationAction.count({ where: { programId: progEE, status: "PLANNED" } })).toBe(0);
    ok(await setRewardScheduleStatus(ctx, schedB, "READY"));
    s = await plan();
    expect(s.planned).toBe(1);

    expect((await setIntegrationAutomationMode(ctx, integrationId, "OFF")).ok).toBe(true);
    const before = await allActions();
    s = await plan();
    expect(s.skippedReason).toBe("AUTOMATION_OFF");
    expect((await allActions()).map((a) => `${a.id}:${a.status}`)).toEqual(before.map((a) => `${a.id}:${a.status}`));
    expect((await setIntegrationAutomationMode(ctx, integrationId, "LIVE")).ok).toBe(false);
    expect((await setIntegrationAutomationMode(ctx, integrationId, "DRY_RUN")).ok).toBe(true);

    ok(await bindProgramMarker(ctx, { programId: progB, milestoneId: msA2, fulfillmentMarkerId: markerPlaceholder }));
    s = await plan();
    expect(s.milestonesSkipped.some((m) => m.programId === progB && m.reason === "MARKER_PLACEHOLDER")).toBe(true);
    expect(s.cancelledActions.some((c) => c.reason === "MARKER_UNAVAILABLE")).toBe(true);
    ok(await bindProgramMarker(ctx, { programId: progB, milestoneId: msA2, fulfillmentMarkerId: markerB2 }));
    s = await plan();
    expect(s.planned).toBeGreaterThanOrEqual(1);
  }, 240_000);

  it("milestone passes in dry-run (delivery processed without the marker) → CANCELLED MILESTONE_PASSED", async () => {
    await prisma.subscriptionOrder.create({ data: { organizationId: org.id, integrationId, subscriptionId: subIds["N-1"], externalSubscriptionId: "N-1", externalOrderId: "N-1-o99", externalCustomerId: "c-fresh", externalAddressId: "addr-N-1", orderKind: "RECURRING", orderStatus: "success", processedAt: new Date("2026-08-20T09:00:00Z"), externalProductId: MM_PRODUCT, externalVariantId: MM_VARIANT } });
    await recalcAll();
    const s = await plan();
    expect(s.cancelledActions.some((c) => c.reason === "MILESTONE_PASSED")).toBe(true);
    expect((await prisma.automationAction.findMany({ where: { subscriptionId: subIds["N-1"], status: "PLANNED" } })).length).toBe(0);
  }, 180_000);

  it("preview mode (persist=false) reports the same decisions without writing", async () => {
    const before = (await allActions()).length;
    const runsBefore = await prisma.plannerRun.count({ where: { organizationId: org.id } });
    const s = await plan({ persist: false });
    expect(s.persisted).toBe(false);
    expect(s.decisions.some((d) => d.outcome === "CONFIRMED")).toBe(true);
    expect((await allActions()).length).toBe(before);
    expect(await prisma.plannerRun.count({ where: { organizationId: org.id } })).toBe(runsBefore);
  }, 120_000);
});

describe("dry run", () => {
  // make the describe self-contained: whatever the planner tests left behind, EE-1 must have a PLANNED action here
  beforeAll(async () => {
    ok(await setRewardScheduleStatus(ctx, schedB, "READY"));
    await plan();
  }, 120_000);
  const extSub = (over: Partial<ConnectorSubscription> = {}): ConnectorSubscription => ({ externalSubscriptionId: "EE-1", externalCustomerId: "c-ee", externalAddressId: "addr-EE-1", status: "active", providerStatus: "active", externalProductId: EE_PRODUCT, externalVariantId: EE_VARIANT, productTitle: "Evening Elixir", variantTitle: null, sku: null, quantity: 1, price: "34.00", intervalUnit: "day", intervalFrequency: 30, nextChargeDate: "2026-09-21", externalCreatedAt: null, externalUpdatedAt: null, cancelledAt: null, providerData: null, ...over });
  const fake = (sub: ConnectorSubscription, onetimes: ConnectorOnetime[] = []) => ({ getSubscription: async () => sub, listOnetimes: async function* () { yield { items: onetimes }; } });

  it("produces the exact intended one-time payload, names schedule · milestone · reward · marker, and wouldExecute=YES when everything lines up", async () => {
    const a = (await liveActions()).find((x) => x.subscription.externalSubscriptionId === "EE-1")!;
    const r = await dryRunAction(ctx, a.id, { now: NOW, connector: fake(extSub()) });
    expect(r.wouldExecute).toBe(true);
    expect(r.operation).toBe("CREATE_ONETIME");
    expect(r.milestone).toMatchObject({ scheduleName: "Schedule B", cycleNumber: 2, executionMode: "UPCOMING_RENEWAL", eligibilityScope: "CUSTOMER_PROGRAM", readiness: "READY" });
    expect(r.milestone?.rewardItem.name).toBe("Cup");
    expect(r.marker.name).toBe("Evening Elixir 2");
    expect(r.intendedOperation).toMatchObject({ provider: "RECHARGE", method: "POST", path: "/onetimes", sent: false });
    expect(r.intendedOperation.body).toMatchObject({ address_id: "addr-EE-1", next_charge_scheduled_at: "2026-09-21", external_variant_id: { ecommerce: "77004" }, quantity: 1, price: "0.00", product_title: "Evening Elixir 2" });
    const stored = await prisma.automationAction.findUniqueOrThrow({ where: { id: a.id } });
    expect(stored.wouldExecute).toBe(true);
  }, 120_000);

  it("blocks when the provider's next charge moved, when the external read fails, and when the schedule is no longer ready", async () => {
    const a = (await liveActions()).find((x) => x.subscription.externalSubscriptionId === "EE-1")!;
    const moved = await dryRunAction(ctx, a.id, { now: NOW, persist: false, connector: fake(extSub({ nextChargeDate: "2026-09-27" })) });
    expect(moved.blockingReason).toBe("TARGET_CHARGE_MOVED");
    const failing = { getSubscription: async () => { throw new Error("boom"); }, listOnetimes: async function* () { yield { items: [] as ConnectorOnetime[] }; } };
    const failed = await dryRunAction(ctx, a.id, { now: NOW, persist: false, connector: failing });
    expect(failed.blockingReason).toBe("EXTERNAL_READ_FAILED");
    ok(await setRewardScheduleStatus(ctx, schedB, "DRAFT"));
    const notReady = await dryRunAction(ctx, a.id, { now: NOW, persist: false, connector: fake(extSub()) });
    expect(notReady.wouldExecute).toBe(false);
    expect(notReady.blockingReason).toBe("MILESTONE_NOT_READY");
    expect(notReady.blockingDetail).toBe("SCHEDULE_NOT_READY");
    ok(await setRewardScheduleStatus(ctx, schedB, "READY"));
  }, 120_000);

  it("reports ADOPT when an identical one-time already exists on the address", async () => {
    const a = (await liveActions()).find((x) => x.subscription.externalSubscriptionId === "EE-1")!;
    const existing: ConnectorOnetime = { externalOnetimeId: "ot-1", externalAddressId: "addr-EE-1", externalCustomerId: "c-ee", externalProductId: "mk-77004", externalVariantId: "77004", nextChargeDate: "2026-09-21", productTitle: "Evening Elixir 2", sku: "SKU-77004", quantity: 1, price: "0.00", externalCreatedAt: null };
    const r = await dryRunAction(ctx, a.id, { now: NOW, persist: false, connector: fake(extSub(), [existing]) });
    expect(r.wouldExecute).toBe(true);
    expect(r.operation).toBe("ADOPT_EXISTING_ONETIME");
  }, 120_000);
});

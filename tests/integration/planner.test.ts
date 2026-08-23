/**
 * Phase 4 — action planner + DRY_RUN executor against real DB rows.
 *
 * Fixtures are built from SubscriptionOrder facts and the REAL journey recalculation, so the
 * "sync → recalc → planner stays idempotent" case is genuine, and lifecycle counts can be
 * fingerprinted before/after every planner run.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { recalculateJourneysForSubscriptions } from "@/lib/domain/journeys/recalc";
import { planActionsForIntegration } from "@/lib/domain/actions/planner";
import { dryRunAction } from "@/lib/domain/actions/dry-run";
import { setIntegrationAutomationMode } from "@/lib/domain/actions/mode";
import { analyzeMilestoneImpact } from "@/lib/domain/rules/impact";
import { localMidnightUtc } from "@/lib/domain/time";
import type { ConnectorOnetime, ConnectorSubscription } from "@/lib/integrations/types";

const run = Math.random().toString(36).slice(2, 8);
const org = { id: `test_plan_${run}`, slug: `test-plan-${run}`, name: "Planner Test", timezone: "Europe/London", markerLeadHours: 72 };
const ctx = { organizationId: org.id };
let integrationId = "";
let progMM = "";
let progB = "";
let markerMM = "";
let markerMM_alt = "";
let markerPlaceholder = "";
let ruleMM = "";
let ruleB = "";
const subIds: Record<string, string> = {};
const NOW = new Date("2026-08-23T15:00:00Z");

const MM_PRODUCT = "8001";
const MM_VARIANT = "9001";
const B_PRODUCT = "8002";
const B_VARIANT = "9002";

async function mkCustomer(ext: string, name: string) {
  return prisma.customer.create({ data: { organizationId: org.id, integrationId, externalCustomerId: ext, firstName: name, lastName: "Test", email: `${ext}@example.com` } });
}
/** subscription + N successful orders (checkout + recurring); journeys come from the real recalculation */
async function mkSub(opts: { ext: string; customerId: string; externalCustomerId: string; status?: "ACTIVE" | "CANCELLED"; orders: number; next: string | null; product?: string; variant?: string; firstOrderAt?: string; historyProduct?: string; historyOrders?: number }) {
  const product = opts.product ?? MM_PRODUCT;
  const variant = opts.variant ?? MM_VARIANT;
  const sub = await prisma.subscription.create({
    data: {
      organizationId: org.id, integrationId, customerId: opts.customerId, externalSubscriptionId: opts.ext, externalCustomerId: opts.externalCustomerId, externalAddressId: `addr-${opts.ext}`, status: opts.status ?? "ACTIVE",
      externalProductId: product, externalVariantId: variant, productTitleSnapshot: product === MM_PRODUCT ? "Morning Magic" : "Other", nextChargeDate: opts.next, nextChargeAt: opts.next ? localMidnightUtc(opts.next, org.timezone) : null, externalCreatedAt: new Date(opts.firstOrderAt ?? "2026-01-01"),
    },
  });
  subIds[opts.ext] = sub.id;
  let n = 0;
  const mkOrder = async (prod: string, vari: string, kind: "CHECKOUT" | "RECURRING") => {
    n++;
    await prisma.subscriptionOrder.create({ data: { organizationId: org.id, integrationId, subscriptionId: sub.id, externalSubscriptionId: opts.ext, externalOrderId: `${opts.ext}-o${n}`, externalCustomerId: opts.externalCustomerId, externalAddressId: `addr-${opts.ext}`, orderKind: kind, orderStatus: "success", processedAt: new Date(Date.UTC(2026, 0, n, 9)), externalProductId: prod, externalVariantId: vari, productTitle: "x" } });
  };
  // optional history in a different product first (programme change)
  for (let i = 0; i < (opts.historyOrders ?? 0); i++) await mkOrder(opts.historyProduct ?? B_PRODUCT, opts.historyProduct === MM_PRODUCT ? MM_VARIANT : B_VARIANT, i === 0 ? "CHECKOUT" : "RECURRING");
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
const liveActions = () => prisma.automationAction.findMany({ where: { organizationId: org.id, status: "PLANNED" }, include: { subscription: { select: { externalSubscriptionId: true } }, fulfillmentMarker: { select: { id: true } } }, orderBy: { createdAt: "asc" } });
const allActions = () => prisma.automationAction.findMany({ where: { organizationId: org.id }, include: { subscription: { select: { externalSubscriptionId: true } } }, orderBy: { createdAt: "asc" } });
const plan = (o: Partial<Parameters<typeof planActionsForIntegration>[2]> = {}) => planActionsForIntegration(ctx, integrationId, { trigger: "TEST", now: NOW, ...o });

beforeAll(async () => {
  await prisma.organization.create({ data: org });
  const integ = await prisma.integration.create({ data: { organizationId: org.id, provider: "RECHARGE", externalStoreId: `s-${run}`, displayName: "Fake Store", encryptedCredentials: "x", automationMode: "DRY_RUN", status: "CONNECTED" } });
  integrationId = integ.id;
  const pMM = await prisma.product.create({ data: { organizationId: org.id, integrationId, externalProductId: MM_PRODUCT, title: "Morning Magic" } });
  await prisma.productVariant.create({ data: { organizationId: org.id, productId: pMM.id, externalVariantId: MM_VARIANT, title: "1" } });
  const pB = await prisma.product.create({ data: { organizationId: org.id, integrationId, externalProductId: B_PRODUCT, title: "Other" } });
  await prisma.productVariant.create({ data: { organizationId: org.id, productId: pB.id, externalVariantId: B_VARIANT, title: "1" } });
  progMM = (await prisma.subscriptionProgram.create({ data: { organizationId: org.id, name: "Morning Magic Powder" } })).id;
  progB = (await prisma.subscriptionProgram.create({ data: { organizationId: org.id, name: "Other Programme" } })).id;
  await prisma.subscriptionProgramProduct.create({ data: { organizationId: org.id, programId: progMM, productId: pMM.id, variantId: null, variantScope: "*" } });
  await prisma.subscriptionProgramProduct.create({ data: { organizationId: org.id, programId: progB, productId: pB.id, variantId: null, variantScope: "*" } });

  // markers (internal catalogue rows for markers)
  const mk = async (name: string, variant: string, placeholder = false) => {
    const prod = await prisma.product.create({ data: { organizationId: org.id, integrationId, externalProductId: `mk-${variant}`, title: name, type: "FULFILMENT_MARKER" } });
    const v = await prisma.productVariant.create({ data: { organizationId: org.id, productId: prod.id, externalVariantId: variant, title: name, sku: `SKU-${variant}`, price: "0.00" } });
    return (await prisma.fulfillmentMarker.create({ data: { organizationId: org.id, integrationId, name, variantId: v.id, externalVariantId: variant, externalProductId: `mk-${variant}`, title: name, sku: `SKU-${variant}`, source: "MANUAL", placeholder } })).id;
  };
  markerMM = await mk("Morning Magic 2", "77001");
  markerMM_alt = await mk("Morning Magic 2 (alt)", "77002");
  markerPlaceholder = await mk("PLACEHOLDER", "77003", true);

  ruleMM = (await prisma.automationRule.create({ data: { organizationId: org.id, name: "MM delivery 2", status: "READY", eligibilityScope: "CUSTOMER_PROGRAM", milestoneKey: `${org.id}:${progMM}:2`, programId: progMM, cycleNumber: 2, fulfillmentMarkerId: markerMM } })).id;
  ruleB = (await prisma.automationRule.create({ data: { organizationId: org.id, name: "B delivery 2", status: "READY", eligibilityScope: "PER_SUBSCRIPTION", milestoneKey: `${org.id}:${progB}:2`, programId: progB, cycleNumber: 2, fulfillmentMarkerId: markerMM_alt } })).id;

  // population
  const fresh = await mkCustomer("c-fresh", "Fresh");
  const stuart = await mkCustomer("c-stuart", "Stuart");
  const ret = await mkCustomer("c-ret", "Returning");
  const nocharge = await mkCustomer("c-nocharge", "NoCharge");
  const canc = await mkCustomer("c-canc", "Cancelled");
  const moved = await mkCustomer("c-moved", "Moved");
  const danielle = await mkCustomer("c-dan", "Danielle");
  const twin = await mkCustomer("c-twin", "Twin");
  const future = await mkCustomer("c-future", "Future");
  await mkSub({ ext: "N-1", customerId: fresh.id, externalCustomerId: "c-fresh", orders: 1, next: "2026-09-02" }); // ✓ first-cycle customer with a valid next charge
  await mkSub({ ext: "S-old", customerId: stuart.id, externalCustomerId: "c-stuart", status: "CANCELLED", orders: 3, next: null });
  await mkSub({ ext: "S-new", customerId: stuart.id, externalCustomerId: "c-stuart", orders: 0, next: "2026-10-17" }); // Stuart: new sub at 0, lifetime 3
  await mkSub({ ext: "R-old", customerId: ret.id, externalCustomerId: "c-ret", status: "CANCELLED", orders: 1, next: null });
  await mkSub({ ext: "R-new", customerId: ret.id, externalCustomerId: "c-ret", orders: 1, next: "2026-09-05" }); // returning at cycle 1 but lifetime 2 → CUSTOMER_PROGRAM excludes
  await mkSub({ ext: "NC-1", customerId: nocharge.id, externalCustomerId: "c-nocharge", orders: 1, next: null }); // no upcoming charge
  await mkSub({ ext: "X-1", customerId: canc.id, externalCustomerId: "c-canc", status: "CANCELLED", orders: 1, next: "2026-09-09" }); // cancelled
  await mkSub({ ext: "MV-1", customerId: moved.id, externalCustomerId: "c-moved", orders: 1, next: "2026-09-12", product: B_PRODUCT, variant: B_VARIANT, historyProduct: MM_PRODUCT, historyOrders: 1 }); // MM 1 → programme change → B at 1
  await mkSub({ ext: "D-old", customerId: danielle.id, externalCustomerId: "c-dan", status: "CANCELLED", orders: 10, next: null });
  await mkSub({ ext: "D-new", customerId: danielle.id, externalCustomerId: "c-dan", orders: 2, next: "2026-08-31" });
  await mkSub({ ext: "T-a", customerId: twin.id, externalCustomerId: "c-twin", orders: 1, next: "2026-09-03" });
  await mkSub({ ext: "T-b", customerId: twin.id, externalCustomerId: "c-twin", orders: 1, next: "2026-09-04" });
  await mkSub({ ext: "F-1", customerId: future.id, externalCustomerId: "c-future", orders: 0, next: "2026-09-06" }); // future only
  await recalcAll();
}, 180_000);
afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: org.id } });
  await prisma.$disconnect();
});

describe("planner", () => {
  let fpBefore = "";
  it("plans exactly one action per eligible milestone, matching the impact analysis population", async () => {
    fpBefore = await fingerprint();
    const impact = await analyzeMilestoneImpact(ctx, { programId: progMM, cycleNumber: 2 });
    const impactNow = impact.rows.filter((r) => r.eligibility.eligible && r.customerProgram.qualifies).map((r) => r.externalSubscriptionId).sort();
    expect(impactNow).toEqual(["N-1"]);

    const s = await plan();
    expect(s.skippedReason).toBeUndefined();
    expect(s.planned).toBe(2); // N-1 (MM rule) + MV-1 (B rule)
    expect(s.cancelled).toBe(0);
    const live = await liveActions();
    expect(live.map((a) => a.subscription.externalSubscriptionId).sort()).toEqual(["MV-1", "N-1"]);
    // the planner's MM population == the impact analysis population
    const mmPlanned = s.decisions.filter((d) => d.ruleId === ruleMM && d.outcome === "PLANNED").map((d) => d.externalSubscriptionId).sort();
    expect(mmPlanned).toEqual(impactNow);
    // explicit reasons for the exclusions
    const reason = (ext: string) => s.decisions.find((d) => d.ruleId === ruleMM && d.externalSubscriptionId === ext)?.reason;
    expect(reason("S-new")).toBe("CUSTOMER_ALREADY_REACHED_MILESTONE"); // Stuart
    expect(reason("R-new")).toBe("CUSTOMER_ALREADY_REACHED_MILESTONE");
    expect(reason("NC-1")).toBe("NO_UPCOMING_CHARGE");
    expect(reason("X-1")).toBe("SUBSCRIPTION_NOT_ACTIVE");
    expect(reason("D-new")).toBe("MILESTONE_ALREADY_PASSED");
    expect(reason("T-a")).toBe("CUSTOMER_ALREADY_REACHED_MILESTONE");
    expect(reason("F-1")).toBe("NOT_NEXT_CYCLE");
    // MV-1 is evaluated against its CURRENT programme (B), not MM
    expect(s.decisions.find((d) => d.ruleId === ruleMM && d.externalSubscriptionId === "MV-1")).toBeUndefined();
    expect(s.decisions.find((d) => d.ruleId === ruleB && d.externalSubscriptionId === "MV-1")?.outcome).toBe("PLANNED");

    const a = live.find((x) => x.subscription.externalSubscriptionId === "N-1")!;
    expect(a.targetCycle).toBe(2);
    expect(a.targetChargeDate).toBe("2026-09-02"); // exact subscription next-charge date
    expect(a.targetChargeAt?.toISOString()).toBe(localMidnightUtc("2026-09-02", "Europe/London").toISOString()); // 2026-09-01T23:00Z
    expect(a.executeAfter?.toISOString()).toBe(new Date(localMidnightUtc("2026-09-02", "Europe/London").getTime() - 72 * 3_600_000).toISOString()); // 72h lead
    expect(a.eligibilityScope).toBe("CUSTOMER_PROGRAM");
    expect(a.dryRun).toBe(true);
    expect(a.liveKey).toBe(`${a.journeyId}:2:${markerMM}`);
    expect(a.ownerKey).toMatch(/^c:.+:2:/);
    expect(a.externalAddressId).toBe("addr-N-1");
    expect(await prisma.plannerRun.count({ where: { organizationId: org.id, status: "COMPLETED" } })).toBe(1);
  }, 120_000);

  it("re-running repeatedly creates no duplicates", async () => {
    const before = (await allActions()).length;
    const s1 = await plan();
    const s2 = await plan();
    expect(s1.planned + s2.planned).toBe(0);
    expect(s1.confirmed).toBe(2);
    expect((await allActions()).length).toBe(before);
  });

  it("concurrent planner runs create exactly one action for a new milestone", async () => {
    const c = await mkCustomer("c-conc", "Concurrent");
    await mkSub({ ext: "CC-1", customerId: c.id, externalCustomerId: "c-conc", orders: 1, next: "2026-09-15" });
    await recalcAll();
    const results = await Promise.all(Array.from({ length: 5 }, () => plan()));
    expect(results.reduce((n, r) => n + r.planned, 0)).toBe(1);
    const cc = await prisma.automationAction.findMany({ where: { organizationId: org.id, subscription: { externalSubscriptionId: "CC-1" } } });
    expect(cc.length).toBe(1);
  }, 120_000);

  it("incremental sync (recalculation) followed by the planner stays idempotent and leaves lifecycle counts unchanged", async () => {
    const before = (await allActions()).map((a) => a.id).sort();
    const fp1 = await fingerprint();
    await recalcAll();
    const s = await plan();
    expect(s.planned).toBe(0);
    expect((await allActions()).map((a) => a.id).sort()).toEqual(before);
    expect(await fingerprint()).toBe(fp1);
    expect(fp1.split("\n").length).toBe(fpBefore.split("\n").length + 1); // only CC-1's journey was added since the first fingerprint
  }, 120_000);

  it("replans in place when the target charge moves, and cancels with a reason when it disappears", async () => {
    const n1 = (await liveActions()).find((a) => a.subscription.externalSubscriptionId === "N-1")!;
    await prisma.subscription.update({ where: { id: subIds["N-1"] }, data: { nextChargeDate: "2026-09-10", nextChargeAt: localMidnightUtc("2026-09-10", org.timezone) } });
    let s = await plan();
    expect(s.replanned).toBe(1);
    const moved = await prisma.automationAction.findUniqueOrThrow({ where: { id: n1.id } });
    expect(moved.status).toBe("PLANNED");
    expect(moved.targetChargeDate).toBe("2026-09-10");
    expect(moved.replanCount).toBe(1);
    expect(moved.executeAfter?.toISOString()).toBe(new Date(localMidnightUtc("2026-09-10", org.timezone).getTime() - 72 * 3_600_000).toISOString());

    await prisma.subscription.update({ where: { id: subIds["N-1"] }, data: { nextChargeDate: null, nextChargeAt: null } });
    s = await plan();
    expect(s.cancelled).toBe(1);
    const cancelled = await prisma.automationAction.findUniqueOrThrow({ where: { id: n1.id } });
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancelReason).toContain("NO_UPCOMING_CHARGE");
    expect(cancelled.liveKey).toBeNull();
    expect(cancelled.ownerKey).toBeNull();

    // charge comes back → a NEW action (old stays cancelled); still exactly one live
    await prisma.subscription.update({ where: { id: subIds["N-1"] }, data: { nextChargeDate: "2026-09-12", nextChargeAt: localMidnightUtc("2026-09-12", org.timezone) } });
    s = await plan();
    expect(s.planned).toBe(1);
    const n1Actions = await prisma.automationAction.findMany({ where: { subscriptionId: subIds["N-1"] } });
    expect(n1Actions.filter((a) => a.status === "PLANNED").length).toBe(1);
    expect(n1Actions.length).toBe(2);
  }, 120_000);

  it("cancels when the subscription cancels, the rule is disabled, the milestone passes; supersedes when the rule's marker changes", async () => {
    // subscription cancels
    await prisma.subscription.update({ where: { id: subIds["CC-1"] }, data: { status: "CANCELLED" } });
    let s = await plan();
    expect(s.cancelledActions.some((c) => c.reason === "SUBSCRIPTION_NOT_ACTIVE")).toBe(true);

    // rule disabled → CANCELLED RULE_NOT_READY; re-ready → re-planned as a new action
    await prisma.automationRule.update({ where: { id: ruleB }, data: { status: "DISABLED" } });
    s = await plan();
    expect(s.cancelledActions.some((c) => c.reason === "RULE_NOT_READY")).toBe(true);
    await prisma.automationRule.update({ where: { id: ruleB }, data: { status: "READY" } });
    s = await plan();
    expect(s.planned).toBe(1);

    // rule's marker changes → old SUPERSEDED, new action with the new marker
    await prisma.automationRule.update({ where: { id: ruleB }, data: { fulfillmentMarkerId: markerMM } });
    s = await plan();
    expect(s.planned).toBe(1);
    expect(s.superseded).toBe(1);
    const mv = await prisma.automationAction.findMany({ where: { subscriptionId: subIds["MV-1"] }, orderBy: { createdAt: "asc" } });
    const sup = mv.find((a) => a.status === "SUPERSEDED")!;
    const live = mv.find((a) => a.status === "PLANNED")!;
    expect(sup.supersededById).toBe(live.id);
    expect(live.fulfillmentMarkerId).toBe(markerMM);

    // milestone passes in dry-run (target delivery processed without the marker) → CANCELLED MILESTONE_PASSED
    await prisma.subscriptionOrder.create({ data: { organizationId: org.id, integrationId, subscriptionId: subIds["N-1"], externalSubscriptionId: "N-1", externalOrderId: "N-1-o99", externalCustomerId: "c-fresh", externalAddressId: "addr-N-1", orderKind: "RECURRING", orderStatus: "success", processedAt: new Date("2026-08-20T09:00:00Z"), externalProductId: MM_PRODUCT, externalVariantId: MM_VARIANT } });
    await recalcAll();
    s = await plan();
    expect(s.cancelledActions.some((c) => c.reason === "MILESTONE_PASSED")).toBe(true);
    expect((await prisma.automationAction.findMany({ where: { subscriptionId: subIds["N-1"], status: "PLANNED" } })).length).toBe(0);
  }, 180_000);

  it("does nothing while automation is OFF, never plans placeholder-marker rules, and refuses LIVE", async () => {
    const offRes = await setIntegrationAutomationMode(ctx, integrationId, "OFF");
    expect(offRes.ok).toBe(true);
    const before = await allActions();
    const s = await plan();
    expect(s.skippedReason).toBe("AUTOMATION_OFF");
    expect((await allActions()).map((a) => `${a.id}:${a.status}`)).toEqual(before.map((a) => `${a.id}:${a.status}`));
    const live = await setIntegrationAutomationMode(ctx, integrationId, "LIVE");
    expect(live.ok).toBe(false);
    expect(await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } }).then((i) => i.automationMode)).toBe("OFF");
    expect((await setIntegrationAutomationMode(ctx, integrationId, "DRY_RUN")).ok).toBe(true);

    // placeholder: point the MM rule at the placeholder marker → rule skipped, nothing planned for it
    await prisma.automationRule.update({ where: { id: ruleMM }, data: { fulfillmentMarkerId: markerPlaceholder } });
    const c = await mkCustomer("c-ph", "Placeholder");
    await mkSub({ ext: "PH-1", customerId: c.id, externalCustomerId: "c-ph", orders: 1, next: "2026-09-20" });
    await recalcAll();
    const s2 = await plan();
    expect(s2.rulesSkipped.some((r) => r.ruleId === ruleMM && r.reason === "MARKER_PLACEHOLDER")).toBe(true);
    expect(await prisma.automationAction.count({ where: { subscriptionId: subIds["PH-1"] } })).toBe(0);
    await prisma.automationRule.update({ where: { id: ruleMM }, data: { fulfillmentMarkerId: markerMM } });
    const s3 = await plan();
    expect(s3.planned).toBe(1);
  }, 120_000);

  it("preview mode (persist=false) reports the same decisions without writing", async () => {
    const before = (await allActions()).length;
    const runsBefore = await prisma.plannerRun.count({ where: { organizationId: org.id } });
    const s = await plan({ persist: false });
    expect(s.persisted).toBe(false);
    expect(s.decisions.some((d) => d.outcome === "CONFIRMED" && d.externalSubscriptionId === "PH-1")).toBe(true);
    expect((await allActions()).length).toBe(before);
    expect(await prisma.plannerRun.count({ where: { organizationId: org.id } })).toBe(runsBefore);
  });
});

describe("dry run", () => {
  const extSub = (over: Partial<ConnectorSubscription> = {}): ConnectorSubscription => ({ externalSubscriptionId: "PH-1", externalCustomerId: "c-ph", externalAddressId: "addr-PH-1", status: "active", providerStatus: "active", externalProductId: MM_PRODUCT, externalVariantId: MM_VARIANT, productTitle: "Morning Magic", variantTitle: null, sku: null, quantity: 1, price: "34.00", intervalUnit: "day", intervalFrequency: 30, nextChargeDate: "2026-09-20", externalCreatedAt: null, externalUpdatedAt: null, cancelledAt: null, providerData: null, ...over });
  const fake = (sub: ConnectorSubscription, onetimes: ConnectorOnetime[] = []) => ({
    getSubscription: async () => sub,
    listOnetimes: async function* () { yield { items: onetimes }; },
  });

  it("produces the exact intended one-time payload and wouldExecute=YES when everything lines up", async () => {
    const a = (await liveActions()).find((x) => x.subscription.externalSubscriptionId === "PH-1")!;
    const r = await dryRunAction(ctx, a.id, { now: NOW, connector: fake(extSub()) });
    expect(r.wouldExecute).toBe(true);
    expect(r.operation).toBe("CREATE_ONETIME");
    expect(r.timing).toBe("SCHEDULED");
    expect(r.intendedOperation).toMatchObject({ provider: "RECHARGE", method: "POST", path: "/onetimes", sent: false });
    expect(r.intendedOperation.body).toMatchObject({ address_id: "addr-PH-1", next_charge_scheduled_at: "2026-09-20", external_variant_id: { ecommerce: "77001" }, quantity: 1, price: "0.00", product_title: "Morning Magic 2" });
    expect(r.marker.sku).toBe("SKU-77001");
    expect(r.external.read).toBe(true);
    expect(r.journey.lifetimeDeliveries).toBe(1);
    const stored = await prisma.automationAction.findUniqueOrThrow({ where: { id: a.id } });
    expect(stored.wouldExecute).toBe(true);
    expect(stored.lastDryRunAt).not.toBeNull();
  });

  it("blocks when the provider's next charge moved, when the external read fails, and when the marker is a placeholder", async () => {
    const a = (await liveActions()).find((x) => x.subscription.externalSubscriptionId === "PH-1")!;
    const moved = await dryRunAction(ctx, a.id, { now: NOW, persist: false, connector: fake(extSub({ nextChargeDate: "2026-09-27" })) });
    expect(moved.wouldExecute).toBe(false);
    expect(moved.blockingReason).toBe("TARGET_CHARGE_MOVED");

    const failing = { getSubscription: async () => { throw new Error("boom"); }, listOnetimes: async function* () { yield { items: [] as ConnectorOnetime[] }; } };
    const failed = await dryRunAction(ctx, a.id, { now: NOW, persist: false, connector: failing });
    expect(failed.wouldExecute).toBe(false);
    expect(failed.blockingReason).toBe("EXTERNAL_READ_FAILED");

    await prisma.fulfillmentMarker.update({ where: { id: markerMM }, data: { placeholder: true } });
    const ph = await dryRunAction(ctx, a.id, { now: NOW, persist: false, connector: fake(extSub()) });
    expect(ph.wouldExecute).toBe(false);
    expect(ph.blockingReason).toBe("MARKER_PLACEHOLDER");
    await prisma.fulfillmentMarker.update({ where: { id: markerMM }, data: { placeholder: false } });
  });

  it("reports ADOPT when an identical one-time already exists on the address", async () => {
    const a = (await liveActions()).find((x) => x.subscription.externalSubscriptionId === "PH-1")!;
    const existing: ConnectorOnetime = { externalOnetimeId: "ot-1", externalAddressId: "addr-PH-1", externalCustomerId: "c-ph", externalProductId: "mk-77001", externalVariantId: "77001", nextChargeDate: "2026-09-20", productTitle: "Morning Magic 2", sku: "SKU-77001", quantity: 1, price: "0.00", externalCreatedAt: null };
    const r = await dryRunAction(ctx, a.id, { now: NOW, persist: false, connector: fake(extSub(), [existing]) });
    expect(r.wouldExecute).toBe(true);
    expect(r.operation).toBe("ADOPT_EXISTING_ONETIME");
    expect(r.external.existingMarkerOnetime?.externalOnetimeId).toBe("ot-1");
  });
});

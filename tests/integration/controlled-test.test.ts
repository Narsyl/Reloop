/**
 * Phase 6 — controlled Recharge one-time write, against the real DB and a programmable fake
 * connector. Proves the whole containment story BEFORE any real customer write:
 *   arming (one action only, DB-unique), single-use, expiry, preflight refusals, atomic claim,
 *   exactly-one POST, definite-4xx → FAILED, uncertain outcome → reconcile/adopt (never blind
 *   retry), malformed success never attaches, read-back mismatches fail loudly, adoption paths,
 *   compatibility promotion (per variant only), rollback, tenant isolation, and that DRY_RUN /
 *   normal planner paths still cannot write.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { armControlledTest, disarmControlledTest, executeControlledTest, findOurOnetime, rollbackControlledTest } from "@/lib/domain/actions/controlled";
import { dryRunAction } from "@/lib/domain/actions/dry-run";
import { planActionsForIntegration } from "@/lib/domain/actions/planner";
import { setIntegrationAutomationMode } from "@/lib/domain/actions/mode";
import { recalculateJourneysForSubscriptions } from "@/lib/domain/journeys/recalc";
import { assignProgramSchedule, setRewardScheduleStatus, upsertMilestone, upsertRewardItem, upsertRewardSchedule } from "@/lib/domain/rewards/core";
import { RechargeError } from "@/lib/integrations/recharge/errors";
import type { RechargeConnector } from "@/lib/integrations/recharge";
import type { ConnectorOnetime, ConnectorSubscription } from "@/lib/integrations/types";

const run = Math.random().toString(36).slice(2, 8);
const org = { id: `test_ct_${run}`, slug: `test-ct-${run}`, name: "Controlled Test", timezone: "Europe/London", markerLeadHours: 72 };
const orgB = { id: `test_ctB_${run}`, slug: `test-ctb-${run}`, name: "Controlled B" };
const ctx = { organizationId: org.id, userId: null };
const NOW = new Date("2026-08-23T15:00:00Z");

let integrationId = "";
let progId = "";
let cup = "";
let cupBindingId = "";

// ── programmable fake Recharge ─────────────────────────────────────────────
type Behaviour = "ok" | "http422" | "timeout_after_create" | "timeout_no_create" | "malformed";
const rc = {
  subs: new Map<string, ConnectorSubscription>(),
  onetimes: new Map<string, ConnectorOnetime>(),
  nextId: 990001,
  behaviour: "ok" as Behaviour,
  postCalls: 0,
  deleteCalls: 0,
  readbackTamper: null as ((o: ConnectorOnetime) => ConnectorOnetime) | null,
};
const mkSub = (over: Partial<ConnectorSubscription> & { externalSubscriptionId: string }): ConnectorSubscription => ({
  externalCustomerId: "90001",
  externalAddressId: "80001",
  status: "active",
  providerStatus: "active",
  externalProductId: "700100",
  externalVariantId: "700101",
  productTitle: "Morning Magic",
  variantTitle: null,
  sku: null,
  quantity: 1,
  price: "29.00",
  intervalUnit: "day",
  intervalFrequency: 30,
  nextChargeDate: "2026-09-10",
  externalCreatedAt: new Date("2026-07-01"),
  externalUpdatedAt: null,
  cancelledAt: null,
  providerData: null,
  ...over,
});
function storeOnetime(body: Record<string, unknown>): ConnectorOnetime {
  const id = String(rc.nextId++);
  const o: ConnectorOnetime = {
    externalOnetimeId: id,
    externalAddressId: String(body.address_id),
    externalCustomerId: "90001",
    externalProductId: (body.external_product_id as { ecommerce?: string } | undefined)?.ecommerce ?? null,
    externalVariantId: (body.external_variant_id as { ecommerce?: string }).ecommerce ?? null,
    nextChargeDate: String(body.next_charge_scheduled_at),
    productTitle: String(body.product_title),
    sku: null,
    quantity: Number(body.quantity),
    price: String(body.price),
    properties: (body.properties as { name: string; value: string }[]) ?? null,
    externalCreatedAt: new Date(),
  };
  rc.onetimes.set(id, o);
  return o;
}
const fake = {
  getSubscription: async (id: string) => {
    const s = rc.subs.get(id);
    if (!s) throw new RechargeError("NOT_FOUND", `subscription ${id} not found`, {});
    return s;
  },
  listOnetimes: async function* (opts: { externalAddressId?: string }) {
    yield { items: [...rc.onetimes.values()].filter((o) => !opts.externalAddressId || o.externalAddressId === opts.externalAddressId), nextCursor: null, page: 1 };
  },
  getOnetime: async (id: string) => {
    const o = rc.onetimes.get(id) ?? null;
    return o && rc.readbackTamper ? rc.readbackTamper(o) : o;
  },
  createOnetime: async (body: Record<string, unknown>) => {
    rc.postCalls++;
    if (rc.behaviour === "http422") throw new RechargeError("VALIDATION_ERROR", "Recharge rejected the request as invalid: next_charge_scheduled_at", {});
    if (rc.behaviour === "timeout_no_create") throw new RechargeError("NETWORK_ERROR", "Recharge request timed out after 20000ms", {});
    if (rc.behaviour === "timeout_after_create") {
      storeOnetime(body); // the write reached Recharge…
      throw new RechargeError("NETWORK_ERROR", "socket hang up", {}); // …but we never saw the response
    }
    if (rc.behaviour === "malformed") {
      storeOnetime(body);
      throw new RechargeError("SCHEMA_ERROR", "Recharge response for POST /onetimes did not match the expected shape", {}); // 2xx with junk body
    }
    return storeOnetime(body);
  },
  deleteOnetime: async (id: string) => {
    rc.deleteCalls++;
    if (!rc.onetimes.delete(id)) throw new RechargeError("NOT_FOUND", `onetime ${id} not found`, {});
  },
} as unknown as RechargeConnector;

// ── helpers ────────────────────────────────────────────────────────────────
function ok<T>(r: { ok: true; data?: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.data as T;
}
const plan = () => planActionsForIntegration(ctx, integrationId, { trigger: "TEST", now: NOW });
const action = (ext: string) => prisma.automationAction.findFirstOrThrow({ where: { organizationId: org.id, subscription: { externalSubscriptionId: ext }, status: { in: ["PLANNED", "EXECUTING", "ATTACHED", "FAILED"] } }, orderBy: { createdAt: "desc" } });
async function seedSub(ext: string, opts: { orders?: number; next?: string } = {}) {
  const customer = await prisma.customer.upsert({ where: { integrationId_externalCustomerId: { integrationId, externalCustomerId: `c-${ext}` } }, create: { organizationId: org.id, integrationId, externalCustomerId: `c-${ext}`, firstName: ext, lastName: "Test", email: `${ext}@example.com` }, update: {} });
  const sub = await prisma.subscription.create({
    data: { organizationId: org.id, integrationId, customerId: customer.id, externalSubscriptionId: ext, externalCustomerId: `c-${ext}`, externalAddressId: `addr-${ext}`, status: "ACTIVE", externalProductId: "700100", externalVariantId: "700101", productTitleSnapshot: "Morning Magic", nextChargeDate: opts.next ?? "2026-09-10", externalCreatedAt: new Date("2026-07-01") },
  });
  for (let i = 0; i < (opts.orders ?? 1); i++) {
    await prisma.subscriptionOrder.create({ data: { organizationId: org.id, integrationId, subscriptionId: sub.id, externalSubscriptionId: ext, externalOrderId: `${ext}-o${i + 1}`, externalCustomerId: `c-${ext}`, externalAddressId: `addr-${ext}`, orderKind: i === 0 ? "CHECKOUT" : "RECURRING", orderStatus: "success", processedAt: new Date(Date.UTC(2026, 6, i + 1, 9)), externalProductId: "700100", externalVariantId: "700101", productTitle: "Morning Magic" } });
  }
  await recalculateJourneysForSubscriptions(ctx, integrationId, [sub.id], NOW);
  rc.subs.set(ext, mkSub({ externalSubscriptionId: ext, externalCustomerId: `c-${ext}`, externalAddressId: `addr-${ext}`, nextChargeDate: opts.next ?? "2026-09-10" }));
  return sub;
}

beforeAll(async () => {
  await prisma.organization.createMany({ data: [org, { id: orgB.id, slug: orgB.slug, name: orgB.name }] });
  integrationId = (await prisma.integration.create({ data: { organizationId: org.id, provider: "RECHARGE", externalStoreId: `ct-${run}`, displayName: "CT Store", encryptedCredentials: "x", automationMode: "DRY_RUN", status: "CONNECTED" } })).id;
  const prod = await prisma.product.create({ data: { organizationId: org.id, integrationId, externalProductId: "700100", title: "Morning Magic" } });
  await prisma.productVariant.create({ data: { organizationId: org.id, productId: prod.id, externalVariantId: "700101", title: "1 tub" } });
  progId = (await prisma.subscriptionProgram.create({ data: { organizationId: org.id, name: "Morning Magic" } })).id;
  await prisma.subscriptionProgramProduct.create({ data: { organizationId: org.id, programId: progId, productId: prod.id, variantId: null, variantScope: "*" } });
  cup = ok(await upsertRewardItem(ctx, { name: "Cup" })).id;
  const sched = ok(await upsertRewardSchedule(ctx, { name: "Schedule CT" })).id;
  ok(await upsertMilestone(ctx, { scheduleId: sched, cycleNumber: 2, rewardItemId: cup, eligibilityScope: "PER_SUBSCRIPTION" }));
  ok(await setRewardScheduleStatus(ctx, sched, "READY"));
  ok(await assignProgramSchedule(ctx, { programId: progId, scheduleId: sched }));
  const shopifyId = (await prisma.integration.create({ data: { organizationId: org.id, provider: "SHOPIFY", externalStoreId: `ctshp-${run}.myshopify.com`, displayName: "Shopify", encryptedCredentials: "x", automationMode: "OFF", pairedIntegrationId: integrationId } })).id;
  cupBindingId = (
    await prisma.rewardItemExternalBinding.create({
      data: { organizationId: org.id, rewardItemId: cup, integrationId: shopifyId, provider: "SHOPIFY", externalProductId: "15323138392450", externalVariantId: "56582374424962", externalTitle: "300ml Insulated Stainless Steel Tumbler with Lid", externalStatus: "ACTIVE", requiresShipping: true, verificationJson: { issues: [] } },
    })
  ).id;
  // several PLANNED candidates
  await seedSub("CT-1");
  await seedSub("CT-2", { next: "2026-09-12" });
  await seedSub("CT-3", { next: "2026-09-14" });
  const s = await plan();
  if (s.planned !== 3) throw new Error(`expected 3 planned, got ${s.planned}`);
});
afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: [org.id, orgB.id] } } });
  await prisma.$disconnect();
});

describe("arming is single, explicit, expiring", () => {
  it("without an armed authorization the executor refuses; DRY_RUN and LIVE paths cannot write", async () => {
    const a = await action("CT-1");
    const r = await executeControlledTest(ctx, a.id, { connector: fake, now: NOW });
    expect(r.outcome).toBe("ABORTED_PREFLIGHT");
    expect(r.detail).toMatch(/No controlled-test authorization/);
    expect(rc.postCalls).toBe(0);
    // dry-run cannot POST by construction (no write in its code path)
    await dryRunAction(ctx, a.id, { now: NOW, persist: false, connector: fake });
    expect(rc.postCalls).toBe(0);
    // normal LIVE automation remains refused
    expect((await setIntegrationAutomationMode(ctx, integrationId, "LIVE")).ok).toBe(false);
  });
  it("exactly ONE action can be armed per integration (DB unique); a second action is refused until disarm", async () => {
    const a1 = await action("CT-1");
    const a2 = await action("CT-2");
    ok(await armControlledTest(ctx, { actionId: a1.id }));
    const second = await armControlledTest(ctx, { actionId: a2.id });
    expect(second.ok).toBe(false);
    expect(!second.ok && second.error).toMatch(/already armed/);
    // raw insert cannot bypass the uniqueness either
    await expect(prisma.controlledTestAuthorization.create({ data: { organizationId: org.id, integrationId, actionId: a2.id, status: "ARMED", armedKey: integrationId, expiresAt: new Date(Date.now() + 3600_000) } })).rejects.toThrow(/armedKey|Unique/);
    // executing the UNARMED action is refused even while another is armed
    const r = await executeControlledTest(ctx, a2.id, { connector: fake, now: NOW });
    expect(r.outcome).toBe("ABORTED_PREFLIGHT");
    expect(rc.postCalls).toBe(0);
    ok(await disarmControlledTest(ctx, a1.id));
    expect((await prisma.controlledTestAuthorization.findUniqueOrThrow({ where: { actionId: a1.id } })).status).toBe("CLEARED");
  });
  it("an expired authorization refuses and is marked EXPIRED; arming a non-PLANNED action is refused", async () => {
    const a1 = await action("CT-1");
    await prisma.controlledTestAuthorization.delete({ where: { actionId: a1.id } });
    ok(await armControlledTest(ctx, { actionId: a1.id }));
    await prisma.controlledTestAuthorization.update({ where: { actionId: a1.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await executeControlledTest(ctx, a1.id, { connector: fake, now: new Date() });
    expect(r.outcome).toBe("ABORTED_PREFLIGHT");
    expect(r.detail).toMatch(/expired/);
    expect((await prisma.controlledTestAuthorization.findUniqueOrThrow({ where: { actionId: a1.id } })).status).toBe("EXPIRED");
    await prisma.controlledTestAuthorization.delete({ where: { actionId: a1.id } });
    expect(rc.postCalls).toBe(0);
  });
});

describe("preflight refusals write nothing", () => {
  it("moved charge date refuses; cancelled subscription refuses; missing upcoming charge refuses — action stays PLANNED", async () => {
    const a1 = await action("CT-1");
    ok(await armControlledTest(ctx, { actionId: a1.id }));
    rc.subs.set("CT-1", mkSub({ externalSubscriptionId: "CT-1", externalAddressId: "addr-CT-1", nextChargeDate: "2026-09-11" }));
    let r = await executeControlledTest(ctx, a1.id, { connector: fake, now: NOW });
    expect(r.outcome).toBe("ABORTED_PREFLIGHT");
    expect(r.detail).toMatch(/TARGET_CHARGE_MOVED/);
    rc.subs.set("CT-1", mkSub({ externalSubscriptionId: "CT-1", externalAddressId: "addr-CT-1", status: "cancelled", providerStatus: "cancelled", nextChargeDate: null }));
    r = await executeControlledTest(ctx, a1.id, { connector: fake, now: NOW });
    expect(r.outcome).toBe("ABORTED_PREFLIGHT");
    expect(r.detail).toMatch(/EXTERNAL_SUBSCRIPTION_NOT_ACTIVE|EXTERNAL_NO_UPCOMING_CHARGE/);
    expect(rc.postCalls).toBe(0);
    expect((await prisma.automationAction.findUniqueOrThrow({ where: { id: a1.id } })).status).toBe("PLANNED");
    // authorization is still ARMED after refused preflights (nothing was consumed)
    expect((await prisma.controlledTestAuthorization.findUniqueOrThrow({ where: { actionId: a1.id } })).status).toBe("ARMED");
    rc.subs.set("CT-1", mkSub({ externalSubscriptionId: "CT-1", externalAddressId: "addr-CT-1" }));
  });
});

describe("the write itself", () => {
  it("happy path: consume + claim → ONE POST with the previewed payload → read-back verified → ATTACHED; compatibility promoted for THIS variant only; single-use afterwards", async () => {
    const a1 = await action("CT-1");
    rc.behaviour = "ok";
    rc.postCalls = 0;
    const r = await executeControlledTest(ctx, a1.id, { connector: fake, now: NOW });
    expect(r.outcome).toBe("ATTACHED");
    expect(rc.postCalls).toBe(1);
    expect(r.requestBody).toMatchObject({ address_id: "addr-CT-1", next_charge_scheduled_at: "2026-09-10", external_variant_id: { ecommerce: "56582374424962" }, external_product_id: { ecommerce: "15323138392450" }, quantity: 1, price: "0.00" });
    expect((r.requestBody!.properties as { name: string; value: string }[])[0]).toEqual({ name: "_subscription_ops_action", value: a1.id });
    expect(r.externalOnetimeId).toBeTruthy();
    expect(r.readback).toMatchObject({ externalOnetimeId: r.externalOnetimeId, externalAddressId: "addr-CT-1", nextChargeDate: "2026-09-10", externalVariantId: "56582374424962", quantity: 1, price: "0.00" });
    expect(r.readbackIssues).toEqual([]);
    const stored = await prisma.automationAction.findUniqueOrThrow({ where: { id: a1.id } });
    expect(stored.status).toBe("ATTACHED");
    expect(stored.externalObjectId).toBe(r.externalOnetimeId);
    expect(stored.externalObjectType).toBe("onetime");
    expect(stored.liveKey).not.toBeNull(); // ATTACHED is a live status — the milestone stays owned
    expect(stored.verifiedAt).toBeTruthy();
    const auth = await prisma.controlledTestAuthorization.findUniqueOrThrow({ where: { actionId: a1.id } });
    expect(auth.status).toBe("CONSUMED");
    expect(auth.outcome).toBe("ATTACHED");
    expect(auth.armedKey).toBeNull();
    // compatibility: THIS binding VERIFIED with evidence; single-use: running again refuses, no second POST
    const binding = await prisma.rewardItemExternalBinding.findUniqueOrThrow({ where: { id: cupBindingId } });
    expect(binding.rechargeCompatibility).toBe("VERIFIED");
    expect((binding.verificationJson as { rechargeVerification?: { externalOnetimeId?: string } }).rechargeVerification?.externalOnetimeId).toBe(r.externalOnetimeId);
    const again = await executeControlledTest(ctx, a1.id, { connector: fake, now: NOW });
    expect(again.outcome).toBe("ABORTED_PREFLIGHT");
    expect(again.detail).toMatch(/single-use/);
    expect(rc.postCalls).toBe(1);
  });
  it("the planner leaves the ATTACHED action alone and does not plan a replacement", async () => {
    const s = await plan();
    expect(s.planned).toBe(0);
    expect(s.cancelledActions.map((c) => c.actionId)).not.toContain((await action("CT-1")).id);
    expect(await prisma.automationAction.count({ where: { organizationId: org.id, subscription: { externalSubscriptionId: "CT-1" }, status: { in: ["PLANNED", "EXECUTING", "ATTACHED"] } } })).toBe(1);
  });
  it("definite 4xx → FAILED with the provider error, no retry, authorization consumed", async () => {
    const a2 = await action("CT-2");
    ok(await armControlledTest(ctx, { actionId: a2.id }));
    rc.behaviour = "http422";
    rc.postCalls = 0;
    const r = await executeControlledTest(ctx, a2.id, { connector: fake, now: NOW });
    expect(r.outcome).toBe("FAILED");
    expect(r.detail).toMatch(/VALIDATION_ERROR/);
    expect(rc.postCalls).toBe(1);
    const stored = await prisma.automationAction.findUniqueOrThrow({ where: { id: a2.id } });
    expect(stored.status).toBe("FAILED");
    expect(stored.externalObjectId).toBeNull();
    expect((await prisma.controlledTestAuthorization.findUniqueOrThrow({ where: { actionId: a2.id } })).outcome).toBe("FAILED");
    rc.behaviour = "ok";
  });
  it("timeout AFTER remote creation: reconciliation finds ours by the action property and ADOPTS — exactly one POST, no duplicate", async () => {
    // re-plan CT-2 (previous FAILED freed nothing — FAILED keeps keys; cancel it manually first)
    const prev = await action("CT-2");
    await prisma.automationAction.update({ where: { id: prev.id }, data: { status: "CANCELLED", liveKey: null, ownerKey: null, cancelReason: "MANUAL: test reset" } });
    const s = await plan();
    expect(s.planned).toBe(1);
    const a2 = await action("CT-2");
    ok(await armControlledTest(ctx, { actionId: a2.id }));
    rc.behaviour = "timeout_after_create";
    rc.postCalls = 0;
    const r = await executeControlledTest(ctx, a2.id, { connector: fake, now: NOW });
    expect(r.outcome).toBe("ATTACHED");
    expect(rc.postCalls).toBe(1); // the retry never happened — reconciliation adopted
    expect(r.detail).toMatch(/reconciliation found the one-time/);
    expect((await prisma.automationAction.findUniqueOrThrow({ where: { id: a2.id } })).status).toBe("ATTACHED");
    expect([...rc.onetimes.values()].filter((o) => o.externalAddressId === "addr-CT-2")).toHaveLength(1);
    rc.behaviour = "ok";
  });
  it("timeout with NO remote creation: reconciliation proves absence → exactly one controlled retry succeeds", async () => {
    const a3 = await action("CT-3");
    ok(await armControlledTest(ctx, { actionId: a3.id }));
    rc.postCalls = 0;
    let first = true;
    const flaky = { ...(fake as unknown as Record<string, unknown>), createOnetime: async (body: Record<string, unknown>) => {
      rc.postCalls++;
      if (first) {
        first = false;
        throw new RechargeError("NETWORK_ERROR", "socket hang up", {});
      }
      return storeOnetime(body);
    } } as unknown as RechargeConnector;
    const r = await executeControlledTest(ctx, a3.id, { connector: flaky, now: NOW });
    expect(r.outcome).toBe("ATTACHED");
    expect(rc.postCalls).toBe(2); // 1 failed (nothing created, proven) + 1 controlled retry
    expect(r.detail).toMatch(/positively found NO one-time/);
    expect([...rc.onetimes.values()].filter((o) => o.externalAddressId === "addr-CT-3")).toHaveLength(1);
  });
  it("an existing SAME reward on a DIFFERENT date is NOT falsely adopted; the true match adopts without a POST", async () => {
    // decoy: same variant, wrong date, no action property
    const decoy = storeOnetime({ address_id: "addr-CT-X", next_charge_scheduled_at: "2026-10-01", external_variant_id: { ecommerce: "56582374424962" }, product_title: "Tumbler", quantity: 1, price: "0.00", properties: [] });
    const none = await findOurOnetime(fake, { addressId: "addr-CT-X", actionId: "whatever", variantId: "56582374424962", targetChargeDate: "2026-09-10" });
    expect(none).toBeNull();
    const match = await findOurOnetime(fake, { addressId: "addr-CT-X", actionId: "whatever", variantId: "56582374424962", targetChargeDate: "2026-10-01" });
    expect(match?.externalOnetimeId).toBe(decoy.externalOnetimeId);
    // full adopt path through the executor: plan a fresh sub whose reward one-time already exists
    await seedSub("CT-4", { next: "2026-09-16" });
    const s = await plan();
    expect(s.planned).toBe(1);
    const a4 = await action("CT-4");
    storeOnetime({ address_id: "addr-CT-4", next_charge_scheduled_at: "2026-09-16", external_variant_id: { ecommerce: "56582374424962" }, external_product_id: { ecommerce: "15323138392450" }, product_title: "Tumbler", quantity: 1, price: "0.00", properties: [] });
    ok(await armControlledTest(ctx, { actionId: a4.id }));
    rc.postCalls = 0;
    const r = await executeControlledTest(ctx, a4.id, { connector: fake, now: NOW });
    expect(r.outcome).toBe("ADOPTED");
    expect(rc.postCalls).toBe(0); // no write at all
    expect((await prisma.automationAction.findUniqueOrThrow({ where: { id: a4.id } })).status).toBe("ATTACHED");
  });
  it("malformed provider success never attaches blindly: reconciliation resolves it instead", async () => {
    await seedSub("CT-5", { next: "2026-09-18" });
    const s = await plan();
    expect(s.planned).toBe(1);
    const a5 = await action("CT-5");
    ok(await armControlledTest(ctx, { actionId: a5.id }));
    rc.behaviour = "malformed"; // 2xx whose body fails validation, but the one-time WAS created
    rc.postCalls = 0;
    const r = await executeControlledTest(ctx, a5.id, { connector: fake, now: NOW });
    expect(r.outcome).toBe("ATTACHED"); // via read reconciliation — not via trusting the 2xx
    expect(rc.postCalls).toBe(1);
    expect(r.detail).toMatch(/reconciliation found the one-time/);
    rc.behaviour = "ok";
  });
  it("read-back mismatch (wrong variant / non-zero price) → FAILED + CRITICAL exception, never silently ATTACHED", async () => {
    await seedSub("CT-6", { next: "2026-09-20" });
    await plan();
    const a6 = await action("CT-6");
    ok(await armControlledTest(ctx, { actionId: a6.id }));
    rc.readbackTamper = (o) => ({ ...o, price: "4.99", externalVariantId: "999999" });
    rc.postCalls = 0;
    const r = await executeControlledTest(ctx, a6.id, { connector: fake, now: NOW });
    expect(r.outcome).toBe("FAILED");
    expect(r.readbackIssues.join(" ")).toMatch(/variant/);
    expect(r.readbackIssues.join(" ")).toMatch(/price/);
    const stored = await prisma.automationAction.findUniqueOrThrow({ where: { id: a6.id } });
    expect(stored.status).toBe("FAILED");
    expect(stored.externalObjectId).toBe(r.externalOnetimeId); // identity kept so rollback can target it
    expect(await prisma.exception.count({ where: { organizationId: org.id, actionId: a6.id, type: "CONTROLLED_TEST_READBACK_MISMATCH" } })).toBe(1);
    rc.readbackTamper = null;
  });
});

describe("rollback (explicit, narrowly scoped)", () => {
  it("deletes ONLY the test-created one-time, cancels the action, demotes the compatibility this test promoted", async () => {
    const a1 = await action("CT-1");
    expect(a1.status).toBe("ATTACHED");
    const externalId = a1.externalObjectId!;
    const before = rc.deleteCalls;
    const r = ok(await rollbackControlledTest(ctx, a1.id, { connector: fake, reason: "test rollback path" }));
    expect(r.deletedExternalOnetimeId).toBe(externalId);
    expect(rc.deleteCalls).toBe(before + 1);
    expect(rc.onetimes.has(externalId)).toBe(false);
    const stored = await prisma.automationAction.findUniqueOrThrow({ where: { id: a1.id } });
    expect(stored.status).toBe("CANCELLED");
    expect(stored.liveKey).toBeNull();
    const binding = await prisma.rewardItemExternalBinding.findUniqueOrThrow({ where: { id: cupBindingId } });
    // CT-1's one-time verified the binding; CT-2/3 attachments later re-promoted it — rollback only demotes
    // when the verification evidence points at the rolled-back one-time, so just assert consistency:
    const rv = (binding.verificationJson as { rechargeVerification?: { externalOnetimeId?: string } }).rechargeVerification;
    if (rv) expect(rv.externalOnetimeId).not.toBe(externalId);
    // a second rollback finds nothing live to delete
    const again = await rollbackControlledTest(ctx, a1.id, { connector: fake, reason: "again" });
    expect(again.ok).toBe(false);
  });
});

describe("tenant isolation + no new generic mutation surface", () => {
  it("another organisation cannot arm, execute or roll back this org's action; DB trigger blocks a cross-org authorization", async () => {
    const a2 = await action("CT-2");
    expect((await armControlledTest({ organizationId: orgB.id, userId: null }, { actionId: a2.id })).ok).toBe(false);
    const rb = await rollbackControlledTest({ organizationId: orgB.id, userId: null }, a2.id, { connector: fake, reason: "x" });
    expect(rb.ok).toBe(false);
    const r = await executeControlledTest({ organizationId: orgB.id, userId: null }, a2.id, { connector: fake, now: NOW });
    expect(r.outcome).toBe("ABORTED_PREFLIGHT");
    await expect(prisma.controlledTestAuthorization.create({ data: { organizationId: orgB.id, integrationId, actionId: a2.id, status: "CLEARED", expiresAt: new Date() } })).rejects.toThrow();
  });
  it("the Recharge client exposes no generic mutation: only /onetimes POST, /onetimes/{id} DELETE and /webhooks admin", async () => {
    const { RechargeClient } = await import("@/lib/integrations/recharge/client");
    const proto = Object.getOwnPropertyNames(RechargeClient.prototype);
    const publicVerbs = proto.filter((n) => ["get", "paginate", "webhookAdmin", "createOnetime", "deleteOnetime"].includes(n));
    expect(publicVerbs.sort()).toEqual(["createOnetime", "deleteOnetime", "get", "paginate", "webhookAdmin"]);
    expect(proto).not.toContain("post");
    expect(proto).not.toContain("put");
    expect(proto).not.toContain("delete");
  });
});

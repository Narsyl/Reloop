/**
 * Phase 5 — Recharge webhooks, end to end against the real DB:
 *   endpoint: raw-body HMAC validation (constant-time), tenant resolution ONLY from the URL's
 *   integration, durable IntegrationEvent with dedupe, fast responses, queue dispatch (stubbed)
 *   processing: payloads are signals — targeted authoritative GETs (fake connector) feed the SAME
 *   sync upsert/recalc code; duplicates, out-of-order payloads, order-before-subscription races and
 *   overlap with the incremental sync all converge; the existing planner reacts (plan/replan/cancel).
 * ZERO Recharge writes anywhere.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { encryptCredentials } from "@/lib/crypto/credentials";
import { computeRechargeSignature, webhookDedupeKey } from "@/lib/integrations/recharge/webhooks";
import { POST } from "@/app/api/webhooks/recharge/[integrationId]/route";
import { inngest } from "@/lib/jobs/inngest";
import { processIntegrationEvent } from "@/lib/domain/webhooks/process";
import { upsertConnectorOrders } from "@/lib/domain/sync/stages";
import { planActionsForIntegration } from "@/lib/domain/actions/planner";
import { recalculateJourneysForSubscriptions } from "@/lib/domain/journeys/recalc";
import { assignProgramSchedule, setRewardScheduleStatus, upsertMilestone, upsertRewardItem, upsertRewardSchedule } from "@/lib/domain/rewards/core";
import type { ConnectorOrder, ConnectorSubscription } from "@/lib/integrations/types";
import type { RechargeConnector } from "@/lib/integrations/recharge";

const run = Math.random().toString(36).slice(2, 8);
const org = { id: `test_wh_${run}`, slug: `test-wh-${run}`, name: "Webhooks Test", timezone: "Europe/London", markerLeadHours: 72 };
const orgB = { id: `test_whB_${run}`, slug: `test-whb-${run}`, name: "Webhooks B" };
const ctx = { organizationId: org.id };
const SECRET = `whsec_${run}`;
const NOW = new Date("2026-08-23T15:00:00Z");

let integrationId = "";
let noSecretIntegrationId = "";
let shopifyId = "";
let progMM = "";
let whisk = "";
let cup = "";

const sendSpy = vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] } as never);

function request(id: string, body: string, opts: { signature?: string | null; topic?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  const sig = opts.signature === undefined ? computeRechargeSignature(body, SECRET) : opts.signature;
  if (sig) headers.set("x-recharge-hmac-sha256", sig);
  if (opts.topic !== undefined) headers.set("x-recharge-topic", opts.topic);
  return POST(new Request(`http://localhost/api/webhooks/recharge/${id}`, { method: "POST", body, headers }), { params: Promise.resolve({ integrationId: id }) });
}

// ── fake authoritative Recharge (GET-only surface used by processing) ──
const live = { subs: new Map<string, ConnectorSubscription>(), orders: new Map<string, ConnectorOrder>() };
const fakeConnector = {
  getOrder: async (id: string) => {
    const o = live.orders.get(id);
    if (!o) {
      const { RechargeError } = await import("@/lib/integrations/recharge/errors");
      throw new RechargeError("NOT_FOUND", `order ${id} not found`, {});
    }
    return o;
  },
  getSubscription: async (id: string) => {
    const s = live.subs.get(id);
    if (!s) {
      const { RechargeError } = await import("@/lib/integrations/recharge/errors");
      throw new RechargeError("NOT_FOUND", `subscription ${id} not found`, {});
    }
    return s;
  },
} as unknown as RechargeConnector;

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
const mkOrder = (id: string, subId: string, over: Partial<ConnectorOrder> = {}): ConnectorOrder => ({
  externalOrderId: id,
  externalCustomerId: "90001",
  externalAddressId: "80001",
  externalChargeId: `ch-${id}`,
  platformOrderId: `shp-${id}`,
  status: "success",
  kind: "CHECKOUT",
  processedAt: new Date("2026-08-10T09:00:00Z"),
  scheduledAt: null,
  lineItems: [{ purchaseItemId: subId, purchaseItemType: "subscription", externalProductId: "700100", externalVariantId: "700101", quantity: 1, title: "Morning Magic", sku: null }],
  ...over,
});
const process_ = (eventId: string) => processIntegrationEvent(ctx, eventId, { connector: fakeConnector, timezone: org.timezone, now: NOW });
const plan = () => planActionsForIntegration(ctx, integrationId, { trigger: "TEST", now: NOW });
const lastEvent = () => prisma.integrationEvent.findFirstOrThrow({ where: { organizationId: org.id }, orderBy: { receivedAt: "desc" } });
function ok<T>(r: { ok: true; data?: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.data as T;
}

beforeAll(async () => {
  await prisma.organization.createMany({ data: [org, { id: orgB.id, slug: orgB.slug, name: orgB.name }] });
  // integration with REAL encrypted credentials (test key ring) — the route decrypts the clientSecret
  const integ = await prisma.integration.create({ data: { organizationId: org.id, provider: "RECHARGE", externalStoreId: `wh-${run}`, displayName: "WH Store", encryptedCredentials: "pending", automationMode: "DRY_RUN", status: "CONNECTED" } });
  integrationId = integ.id;
  await prisma.integration.update({ where: { id: integrationId }, data: { encryptedCredentials: encryptCredentials({ apiToken: `tok_${run}_1234567890`, clientSecret: SECRET }, integrationId) } });
  const noSecret = await prisma.integration.create({ data: { organizationId: org.id, provider: "RECHARGE", externalStoreId: `wh2-${run}`, displayName: "No Secret", encryptedCredentials: "pending", status: "CONNECTED" } });
  noSecretIntegrationId = noSecret.id;
  await prisma.integration.update({ where: { id: noSecretIntegrationId }, data: { encryptedCredentials: encryptCredentials({ apiToken: `tok2_${run}_1234567890`, clientSecret: null }, noSecretIntegrationId) } });
  // programme + schedule + reward binding so the planner example works end to end
  const prod = await prisma.product.create({ data: { organizationId: org.id, integrationId, externalProductId: "700100", title: "Morning Magic" } });
  await prisma.productVariant.create({ data: { organizationId: org.id, productId: prod.id, externalVariantId: "700101", title: "1 tub" } });
  progMM = (await prisma.subscriptionProgram.create({ data: { organizationId: org.id, name: "Morning Magic" } })).id;
  await prisma.subscriptionProgramProduct.create({ data: { organizationId: org.id, programId: progMM, productId: prod.id, variantId: null, variantScope: "*" } });
  whisk = ok(await upsertRewardItem(ctx, { name: "Whisk" })).id;
  cup = ok(await upsertRewardItem(ctx, { name: "Cup" })).id;
  const sched = ok(await upsertRewardSchedule(ctx, { name: "Schedule W" })).id;
  ok(await upsertMilestone(ctx, { scheduleId: sched, cycleNumber: 2, rewardItemId: cup, eligibilityScope: "CUSTOMER_PROGRAM" }));
  ok(await setRewardScheduleStatus(ctx, sched, "READY"));
  ok(await assignProgramSchedule(ctx, { programId: progMM, scheduleId: sched }));
  shopifyId = (await prisma.integration.create({ data: { organizationId: org.id, provider: "SHOPIFY", externalStoreId: `whshp-${run}.myshopify.com`, displayName: "Shopify", encryptedCredentials: "x", automationMode: "OFF", pairedIntegrationId: integrationId } })).id;
  await prisma.rewardItemExternalBinding.createMany({
    data: [
      { organizationId: org.id, rewardItemId: cup, integrationId: shopifyId, provider: "SHOPIFY", externalProductId: "p-1", externalVariantId: "555100", externalTitle: "Ceramic Cup", externalStatus: "ACTIVE", requiresShipping: true, verificationJson: { issues: [] } },
      { organizationId: org.id, rewardItemId: whisk, integrationId: shopifyId, provider: "SHOPIFY", externalProductId: "p-2", externalVariantId: "555200", externalTitle: "Whisk", externalStatus: "ACTIVE", requiresShipping: true, verificationJson: { issues: [] } },
    ],
  });
});
afterAll(async () => {
  sendSpy.mockRestore();
  await prisma.organization.deleteMany({ where: { id: { in: [org.id, orgB.id] } } });
  await prisma.$disconnect();
});

describe("webhook endpoint", () => {
  it("valid signature → 200, immutable event persisted once, queued with ids only; identical redelivery → 200 duplicate, still one row", async () => {
    const body = JSON.stringify({ subscription: { id: 555001, status: "active" } });
    sendSpy.mockClear();
    const res = await request(integrationId, body, { topic: "subscription/updated" });
    expect(res.status).toBe(200);
    const events = await prisma.integrationEvent.findMany({ where: { integrationId, eventType: "subscription/updated" } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ organizationId: org.id, provider: "RECHARGE", signatureValid: true, status: "RECEIVED", externalEventId: "555001", dedupeKey: webhookDedupeKey("subscription/updated", body) });
    expect(events[0].dispatchedAt).toBeTruthy();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(sendSpy.mock.calls[0][0]);
    expect(sent).toContain(events[0].id);
    expect(sent).not.toContain(SECRET);
    expect(sent).not.toContain("555001"); // ids only, no payload

    const res2 = await request(integrationId, body, { topic: "subscription/updated" });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toMatchObject({ ok: true, duplicate: true });
    expect(await prisma.integrationEvent.count({ where: { integrationId, eventType: "subscription/updated" } })).toBe(1);
    await prisma.integrationEvent.deleteMany({ where: { integrationId, eventType: "subscription/updated" } });
  });
  it("invalid or missing signature → 401, recorded as IGNORED with signatureValid=false, never queued", async () => {
    const body = JSON.stringify({ order: { id: 1 } });
    sendSpy.mockClear();
    expect((await request(integrationId, body, { topic: "order/created", signature: "0".repeat(64) })).status).toBe(401);
    expect((await request(integrationId, body, { topic: "order/created", signature: null })).status).toBe(401);
    const rejected = await prisma.integrationEvent.findMany({ where: { integrationId, signatureValid: false } });
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(rejected.every((e) => e.status === "IGNORED")).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    await prisma.integrationEvent.deleteMany({ where: { integrationId, signatureValid: false } });
  });
  it("unknown integration → 404; Shopify integration → 404; missing client secret → 503; tenancy comes ONLY from the URL", async () => {
    const body = JSON.stringify({ order: { id: 2 } });
    expect((await request("does-not-exist", body, { topic: "order/created" })).status).toBe(404);
    expect((await request(shopifyId, body, { topic: "order/created" })).status).toBe(404);
    const res = await request(noSecretIntegrationId, body, { topic: "order/created" });
    expect(res.status).toBe(503);
    // payload naming another org's data cannot steer the event anywhere else
    const evil = JSON.stringify({ subscription: { id: 1, organization: orgB.id } });
    const res2 = await request(integrationId, evil, { topic: "subscription/updated" });
    expect(res2.status).toBe(200);
    expect((await lastEvent()).organizationId).toBe(org.id);
    await prisma.integrationEvent.deleteMany({ where: { integrationId } });
  });
});

describe("webhook processing (targeted reconcile through the shared sync code)", () => {
  it("delivery 1 completes: order/created → authoritative GET → order + subscription imported, JourneyCycle 1, planner PLANNS the delivery-2 reward (user example, zero Recharge writes)", async () => {
    live.subs.set("610001", mkSub({ externalSubscriptionId: "610001" }));
    live.orders.set("710001", mkOrder("710001", "610001"));
    const body = JSON.stringify({ order: { id: 710001 } });
    await request(integrationId, body, { topic: "order/created" });
    const event = await lastEvent();
    const outcome = await process_(event.id);
    expect(outcome.outcome).toBe("PROCESSED");
    expect(outcome.plannerRelevant).toBe(true);

    const sub = await prisma.subscription.findUniqueOrThrow({ where: { integrationId_externalSubscriptionId: { integrationId, externalSubscriptionId: "610001" } }, include: { latestJourney: { include: { cycles: true } } } });
    expect(sub.status).toBe("ACTIVE");
    expect(sub.mappingStatus).toBe("MAPPED");
    expect(sub.latestJourney?.successfulCycles).toBe(1);
    expect(sub.latestJourney?.cycles.map((c) => c.externalOrderId)).toEqual(["710001"]);

    const s = await plan();
    expect(s.planned).toBe(1);
    const action = await prisma.automationAction.findFirstOrThrow({ where: { subscriptionId: sub.id, status: "PLANNED" } });
    expect(action.targetCycle).toBe(2);
    expect(action.rewardItemId).toBe(cup);
    expect(action.targetChargeDate).toBe("2026-09-10");
  }, 60_000);

  it("re-processing the same event and a second identical webhook are both no-ops (idempotent)", async () => {
    const event = await lastEvent();
    const again = await process_(event.id);
    expect(again.outcome).toBe("ALREADY_PROCESSED");
    const cycleCount = await prisma.journeyCycle.count({ where: { organizationId: org.id } });
    const before = await prisma.automationAction.count({ where: { organizationId: org.id } });
    // Recharge redelivers: same body → deduped at the door; force-process a fresh identical event anyway
    await prisma.integrationEvent.update({ where: { id: event.id }, data: { status: "RECEIVED", processedAt: null } });
    const reprocessed = await process_(event.id);
    expect(reprocessed.outcome).toBe("PROCESSED");
    expect(await prisma.journeyCycle.count({ where: { organizationId: org.id } })).toBe(cycleCount);
    const s = await plan();
    expect(s.planned).toBe(0);
    expect(await prisma.automationAction.count({ where: { organizationId: org.id } })).toBe(before);
  }, 60_000);

  it("out-of-order / stale payloads are irrelevant: the authoritative GET wins; a moved next-charge REPLANS the same action in place", async () => {
    live.subs.set("610001", mkSub({ externalSubscriptionId: "610001", nextChargeDate: "2026-09-18" }));
    // the webhook payload still claims the OLD date — processing must ignore it
    const body = JSON.stringify({ subscription: { id: 610001, next_charge_scheduled_at: "2026-09-10T00:00:00" } });
    await request(integrationId, body, { topic: "subscription/updated" });
    const outcome = await process_((await lastEvent()).id);
    expect(outcome.outcome).toBe("PROCESSED");
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { integrationId_externalSubscriptionId: { integrationId, externalSubscriptionId: "610001" } } });
    expect(sub.nextChargeDate).toBe("2026-09-18");
    const actionBefore = await prisma.automationAction.findFirstOrThrow({ where: { subscriptionId: sub.id, status: "PLANNED" } });
    const s = await plan();
    expect(s.replanned).toBe(1);
    const actionAfter = await prisma.automationAction.findUniqueOrThrow({ where: { id: actionBefore.id } });
    expect(actionAfter.targetChargeDate).toBe("2026-09-18");
    expect(actionAfter.status).toBe("PLANNED");
    expect(await prisma.automationAction.count({ where: { subscriptionId: sub.id, status: "PLANNED" } })).toBe(1);
  }, 60_000);

  it("order arriving BEFORE its subscription exists fetches the subscription too, links the orphan line and recalculates", async () => {
    live.subs.set("620001", mkSub({ externalSubscriptionId: "620001", externalCustomerId: "90002", externalAddressId: "80002", nextChargeDate: "2026-09-20" }));
    live.orders.set("720001", mkOrder("720001", "620001", { externalCustomerId: "90002", externalAddressId: "80002", processedAt: new Date("2026-08-12T09:00:00Z") }));
    await request(integrationId, JSON.stringify({ order: { id: 720001 } }), { topic: "order/created" });
    const outcome = await process_((await lastEvent()).id);
    expect(outcome.outcome).toBe("PROCESSED");
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { integrationId_externalSubscriptionId: { integrationId, externalSubscriptionId: "620001" } }, include: { latestJourney: true, orders: true } });
    expect(sub.latestJourney?.successfulCycles).toBe(1);
    expect(sub.orders.map((o) => o.externalOrderId)).toEqual(["720001"]);
  }, 60_000);

  it("a non-success order creates NO cycle evidence (semantics preserved); a vanished order is IGNORED", async () => {
    live.orders.set("730001", mkOrder("730001", "610001", { status: "error", processedAt: null }));
    await request(integrationId, JSON.stringify({ order: { id: 730001 } }), { topic: "order/processed" });
    const outcome = await process_((await lastEvent()).id);
    expect(outcome.outcome).toBe("PROCESSED");
    expect(outcome.detail).toContain("no cycle evidence");
    expect(await prisma.subscriptionOrder.count({ where: { organizationId: org.id, externalOrderId: "730001" } })).toBe(0);
    await request(integrationId, JSON.stringify({ order: { id: 999999 } }), { topic: "order/created" });
    expect((await process_((await lastEvent()).id)).outcome).toBe("IGNORED");
  }, 60_000);

  it("subscription/cancelled → authoritative GET → planner CANCELS the planned reward", async () => {
    live.subs.set("610001", mkSub({ externalSubscriptionId: "610001", status: "cancelled", providerStatus: "cancelled", nextChargeDate: null, cancelledAt: new Date("2026-08-23T10:00:00Z") }));
    await request(integrationId, JSON.stringify({ subscription: { id: 610001, status: "cancelled" } }), { topic: "subscription/cancelled" });
    const outcome = await process_((await lastEvent()).id);
    expect(outcome.outcome).toBe("PROCESSED");
    const s = await plan();
    expect(s.cancelledActions.some((c) => c.reason === "SUBSCRIPTION_NOT_ACTIVE")).toBe(true);
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { integrationId_externalSubscriptionId: { integrationId, externalSubscriptionId: "610001" } } });
    expect(await prisma.automationAction.count({ where: { subscriptionId: sub.id, status: "PLANNED" } })).toBe(0);
    // reactivation replans cleanly
    live.subs.set("610001", mkSub({ externalSubscriptionId: "610001", nextChargeDate: "2026-09-25" }));
    await request(integrationId, JSON.stringify({ subscription: { id: 610001, status: "active" } }), { topic: "subscription/activated" });
    await process_((await lastEvent()).id);
    const s2 = await plan();
    expect(s2.planned).toBe(1);
  }, 60_000);

  it("webhook processing overlapping the incremental sync duplicates nothing (same upsert keys, same cycles, planner idempotent)", async () => {
    const order = live.orders.get("710001")!;
    const cyclesBefore = await prisma.journeyCycle.count({ where: { organizationId: org.id } });
    const actionsBefore = await prisma.automationAction.count({ where: { organizationId: org.id } });
    // the cron sync imports the same order the webhook just processed…
    await upsertConnectorOrders(ctx, integrationId, [order]);
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { integrationId_externalSubscriptionId: { integrationId, externalSubscriptionId: "610001" } }, select: { id: true } });
    await recalculateJourneysForSubscriptions(ctx, integrationId, [sub.id], NOW);
    // …and the webhook is processed once more on top
    await prisma.integrationEvent.updateMany({ where: { integrationId, eventType: "order/created", externalEventId: "710001" }, data: { status: "RECEIVED", processedAt: null } });
    const ev = await prisma.integrationEvent.findFirstOrThrow({ where: { integrationId, eventType: "order/created", externalEventId: "710001" } });
    await process_(ev.id);
    expect(await prisma.subscriptionOrder.count({ where: { organizationId: org.id, externalOrderId: "710001" } })).toBe(1);
    expect(await prisma.journeyCycle.count({ where: { organizationId: org.id } })).toBe(cyclesBefore);
    const s = await plan();
    expect(s.planned).toBe(0);
    expect(await prisma.automationAction.count({ where: { organizationId: org.id } })).toBe(actionsBefore);
  }, 60_000);

  it("tenant isolation: another organisation cannot process or even see the event", async () => {
    const ev = await prisma.integrationEvent.findFirstOrThrow({ where: { organizationId: org.id } });
    await expect(processIntegrationEvent({ organizationId: orgB.id }, ev.id, { connector: fakeConnector, timezone: "Europe/London" })).rejects.toThrow(/not found/);
  });
});

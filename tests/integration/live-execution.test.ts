/**
 * LIVE execution — the batch executor against the real DB and a programmable fake connector.
 * Proves: LIVE is settable and the executor only runs under it; due actions execute oldest
 * first through the full engine (fresh preflight, verified-binding gate, atomic claim,
 * exactly-one POST, reconcile-then-adopt on ambiguity, authoritative read-back); blocked or
 * unverified actions stay PLANNED untouched; failures surface as exceptions; reruns are
 * idempotent; executedVia records the authority.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { executeDueActions } from "@/lib/domain/actions/execute";
import { planActionsForIntegration } from "@/lib/domain/actions/planner";
import { setIntegrationAutomationMode } from "@/lib/domain/actions/mode";
import { recalculateJourneysForSubscriptions } from "@/lib/domain/journeys/recalc";
import { assignProgramSchedule, setRewardScheduleStatus, upsertMilestone, upsertRewardItem, upsertRewardSchedule } from "@/lib/domain/rewards/core";
import { RechargeError } from "@/lib/integrations/recharge/errors";
import type { RechargeConnector } from "@/lib/integrations/recharge";
import type { ConnectorOnetime, ConnectorSubscription } from "@/lib/integrations/types";

const run = Math.random().toString(36).slice(2, 8);
const org = { id: `test_lx_${run}`, slug: `test-lx-${run}`, name: "Live Exec Test", timezone: "Europe/London", markerLeadHours: 72 };
const ctx = { organizationId: org.id, userId: null };
const NOW = new Date("2026-09-09T15:00:00Z");
const DUE = "2026-09-11"; // executeAfter = local midnight − 72h ≈ 8 Sep, well before NOW
const NOT_DUE = "2026-10-05";

let integrationId = "";
let cup = "";
let cupBindingId = "";

type Behaviour = "ok" | "http422" | "timeout_after_create";
const rc = {
  subs: new Map<string, ConnectorSubscription>(),
  onetimes: new Map<string, ConnectorOnetime>(),
  nextId: 550001,
  behaviour: "ok" as Behaviour,
  postCalls: 0,
  readbackTamper: null as ((o: ConnectorOnetime) => ConnectorOnetime) | null,
};
const mkSub = (over: Partial<ConnectorSubscription> & { externalSubscriptionId: string }): ConnectorSubscription => ({
  externalCustomerId: "70001",
  externalAddressId: "60001",
  status: "active",
  providerStatus: "active",
  externalProductId: "800100",
  externalVariantId: "800101",
  productTitle: "Lions Mane",
  variantTitle: null,
  sku: null,
  quantity: 1,
  price: "24.00",
  intervalUnit: "day",
  intervalFrequency: 30,
  nextChargeDate: DUE,
  externalCreatedAt: new Date("2026-08-01"),
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
    externalCustomerId: "70001",
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
    if (rc.behaviour === "http422") throw new RechargeError("VALIDATION_ERROR", "Recharge rejected the request as invalid", {});
    if (rc.behaviour === "timeout_after_create") {
      storeOnetime(body);
      throw new RechargeError("NETWORK_ERROR", "socket hang up", {});
    }
    return storeOnetime(body);
  },
  deleteOnetime: async (id: string) => {
    rc.onetimes.delete(id);
  },
} as unknown as RechargeConnector;

function ok<T>(r: { ok: true; data?: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.data as T;
}
const plan = () => planActionsForIntegration(ctx, integrationId, { trigger: "TEST", now: NOW });
const action = (ext: string) =>
  prisma.automationAction.findFirstOrThrow({ where: { organizationId: org.id, subscription: { externalSubscriptionId: ext }, status: { in: ["PLANNED", "EXECUTING", "ATTACHED", "FAILED"] } }, orderBy: { createdAt: "desc" } });
async function seedSub(ext: string, opts: { next?: string } = {}) {
  const customer = await prisma.customer.upsert({ where: { integrationId_externalCustomerId: { integrationId, externalCustomerId: `c-${ext}` } }, create: { organizationId: org.id, integrationId, externalCustomerId: `c-${ext}`, firstName: ext, lastName: "Test", email: `${ext}@example.com` }, update: {} });
  const sub = await prisma.subscription.create({
    data: { organizationId: org.id, integrationId, customerId: customer.id, externalSubscriptionId: ext, externalCustomerId: `c-${ext}`, externalAddressId: `addr-${ext}`, status: "ACTIVE", externalProductId: "800100", externalVariantId: "800101", productTitleSnapshot: "Lions Mane", nextChargeDate: opts.next ?? DUE, externalCreatedAt: new Date("2026-08-01") },
  });
  await prisma.subscriptionOrder.create({ data: { organizationId: org.id, integrationId, subscriptionId: sub.id, externalSubscriptionId: ext, externalOrderId: `${ext}-o1`, externalCustomerId: `c-${ext}`, externalAddressId: `addr-${ext}`, orderKind: "CHECKOUT", orderStatus: "success", processedAt: new Date("2026-08-01T09:00:00Z"), externalProductId: "800100", externalVariantId: "800101", productTitle: "Lions Mane" } });
  await recalculateJourneysForSubscriptions(ctx, integrationId, [sub.id], NOW);
  rc.subs.set(ext, mkSub({ externalSubscriptionId: ext, externalCustomerId: `c-${ext}`, externalAddressId: `addr-${ext}`, nextChargeDate: opts.next ?? DUE }));
  return sub;
}

beforeAll(async () => {
  await prisma.organization.create({ data: org });
  integrationId = (await prisma.integration.create({ data: { organizationId: org.id, provider: "RECHARGE", externalStoreId: `lx-${run}`, displayName: "LX Store", encryptedCredentials: "x", automationMode: "DRY_RUN", status: "CONNECTED" } })).id;
  const prod = await prisma.product.create({ data: { organizationId: org.id, integrationId, externalProductId: "800100", title: "Lions Mane" } });
  await prisma.productVariant.create({ data: { organizationId: org.id, productId: prod.id, externalVariantId: "800101", title: "1 tub" } });
  const progId = (await prisma.subscriptionProgram.create({ data: { organizationId: org.id, name: "Lions Mane" } })).id;
  await prisma.subscriptionProgramProduct.create({ data: { organizationId: org.id, programId: progId, productId: prod.id, variantId: null, variantScope: "*" } });
  cup = ok(await upsertRewardItem(ctx, { name: "Cup" })).id;
  const sched = ok(await upsertRewardSchedule(ctx, { name: "Schedule LX" })).id;
  ok(await upsertMilestone(ctx, { scheduleId: sched, cycleNumber: 2, rewardItemId: cup, eligibilityScope: "PER_SUBSCRIPTION" }));
  ok(await setRewardScheduleStatus(ctx, sched, "READY"));
  ok(await assignProgramSchedule(ctx, { programId: progId, scheduleId: sched }));
  const shopifyId = (await prisma.integration.create({ data: { organizationId: org.id, provider: "SHOPIFY", externalStoreId: `lxshp-${run}.myshopify.com`, displayName: "Shopify", encryptedCredentials: "x", automationMode: "OFF", pairedIntegrationId: integrationId } })).id;
  cupBindingId = (
    await prisma.rewardItemExternalBinding.create({
      data: { organizationId: org.id, rewardItemId: cup, integrationId: shopifyId, provider: "SHOPIFY", externalProductId: "900100", externalVariantId: "900101", externalTitle: "Ceramic Cup", externalStatus: "ACTIVE", requiresShipping: true, rechargeCompatibility: "VERIFIED", verificationJson: { issues: [] } },
    })
  ).id;
  await seedSub("LX-1");
  await seedSub("LX-2");
  await seedSub("LX-3");
  await seedSub("LX-LATER", { next: NOT_DUE });
  const s = await plan();
  if (s.planned !== 4) throw new Error(`expected 4 planned, got ${s.planned}`);
});
afterAll(async () => {
  await prisma.organization.delete({ where: { id: org.id } });
  await prisma.$disconnect();
});

describe("mode gating", () => {
  it("the executor refuses unless the integration is LIVE; switching modes writes nothing by itself", async () => {
    const r = await executeDueActions(ctx, integrationId, { connector: fake, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not live/i);
    expect(rc.postCalls).toBe(0);
    expect((await setIntegrationAutomationMode(ctx, integrationId, "LIVE")).ok).toBe(true);
    expect(rc.postCalls).toBe(0);
  });
});

describe("the live batch", () => {
  it("skips every action while the reward binding is not VERIFIED, leaving them PLANNED", async () => {
    await prisma.rewardItemExternalBinding.update({ where: { id: cupBindingId }, data: { rechargeCompatibility: "UNVERIFIED" } });
    const r = await executeDueActions(ctx, integrationId, { connector: fake, now: NOW });
    expect(r.ok).toBe(true);
    expect(r.due).toBe(3);
    expect(r.skipped).toBe(3);
    expect(rc.postCalls).toBe(0);
    expect((await action("LX-1")).status).toBe("PLANNED");
    await prisma.rewardItemExternalBinding.update({ where: { id: cupBindingId }, data: { rechargeCompatibility: "VERIFIED" } });
  });

  it("a blocked preflight leaves the action PLANNED with the persisted reason and writes nothing", async () => {
    rc.subs.set("LX-1", mkSub({ externalSubscriptionId: "LX-1", externalCustomerId: "c-LX-1", externalAddressId: "addr-LX-1", nextChargeDate: "2026-09-25" })); // date moved
    const r = await executeDueActions(ctx, integrationId, { connector: fake, now: NOW });
    expect(r.ok).toBe(true);
    const one = r.results.find((x) => x.outcome === "SKIPPED" && x.detail.includes("TARGET_CHARGE_MOVED"));
    expect(one).toBeTruthy();
    const a1 = await action("LX-1");
    expect(a1.status).toBe("PLANNED");
    expect(a1.blockingReason).toContain("TARGET_CHARGE_MOVED");
    // the other two due actions executed through the full path
    expect(r.attached).toBe(2);
    expect(rc.postCalls).toBe(2);
    const a2 = await action("LX-2");
    expect(a2.status).toBe("ATTACHED");
    expect(a2.executedVia).toBe("LIVE_AUTOMATION");
    expect(a2.externalObjectId).toBeTruthy();
    const live = rc.onetimes.get(a2.externalObjectId!);
    expect(live?.nextChargeDate).toBe(DUE);
    expect(live?.price).toBe("0.00");
    expect(live?.quantity).toBe(1);
    // the not-yet-due action was never considered
    expect((await action("LX-LATER")).status).toBe("PLANNED");
  });

  it("reruns are idempotent: nothing left due executes twice", async () => {
    const posts = rc.postCalls;
    const r = await executeDueActions(ctx, integrationId, { connector: fake, now: NOW });
    expect(r.attached).toBe(0);
    expect(rc.postCalls).toBe(posts);
  });

  it("a definite provider rejection fails the action and opens an exception", async () => {
    await seedSub("LX-BAD");
    await plan();
    rc.behaviour = "http422";
    const r = await executeDueActions(ctx, integrationId, { connector: fake, now: NOW });
    rc.behaviour = "ok";
    expect(r.failed).toBe(1);
    const a = await action("LX-BAD");
    expect(a.status).toBe("FAILED");
    const ex = await prisma.exception.findFirst({ where: { organizationId: org.id, actionId: a.id, type: "GIFT_EXECUTION_FAILED" } });
    expect(ex).toBeTruthy();
  });

  it("an ambiguous write reconciles by read and adopts, never creating a duplicate", async () => {
    await seedSub("LX-AMB");
    await plan();
    rc.behaviour = "timeout_after_create";
    const posts = rc.postCalls;
    const r = await executeDueActions(ctx, integrationId, { connector: fake, now: NOW });
    rc.behaviour = "ok";
    expect(r.attached).toBe(1);
    expect(rc.postCalls).toBe(posts + 1); // one POST; the recovery was a read, not a retry
    const a = await action("LX-AMB");
    expect(a.status).toBe("ATTACHED");
    const ours = [...rc.onetimes.values()].filter((o) => o.externalAddressId === "addr-LX-AMB");
    expect(ours.length).toBe(1);
  });

  it("a read-back mismatch fails loudly, keeps the external id, and the batch continues", async () => {
    await seedSub("LX-TAMPER");
    await plan();
    rc.readbackTamper = (o) => ({ ...o, price: "4.99" });
    const r = await executeDueActions(ctx, integrationId, { connector: fake, now: NOW });
    rc.readbackTamper = null;
    expect(r.failed).toBe(1);
    const a = await action("LX-TAMPER");
    expect(a.status).toBe("FAILED");
    expect(a.externalObjectId).toBeTruthy();
    const ex = await prisma.exception.findFirst({ where: { organizationId: org.id, actionId: a.id, type: "GIFT_READBACK_MISMATCH", severity: "CRITICAL" } });
    expect(ex).toBeTruthy();
  });
});

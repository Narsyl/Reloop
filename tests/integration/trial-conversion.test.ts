/**
 * Trial conversion — the sweep engine against the real DB and a programmable fake connector.
 * Proves the operator's rule end to end: a subscription that has cancelled is NEVER converted —
 * cancellations are caught at the day-mark checkpoints, in synced data, and at the final fresh
 * check immediately before the write. Also proves: DRY_RUN withholds the write, LIVE performs
 * exactly one verified PUT, manual swaps are adopted not repeated, ambiguous writes reconcile
 * by read, definite failures and read-back mismatches raise exceptions, charge-race and
 * delayed-charge guards postpone, and reruns are idempotent.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { runTrialConversionSweep, type TrialCheckpoint } from "@/lib/domain/trial-conversion/engine";
import { RechargeError } from "@/lib/integrations/recharge/errors";
import type { RechargeConnector, RechargeSubscriptionSwapBody } from "@/lib/integrations/recharge";
import type { ConnectorSubscription } from "@/lib/integrations/types";

const run = Math.random().toString(36).slice(2, 8);
const org = { id: `test_tc_${run}`, slug: `test-tc-${run}`, name: "Trial Conversion Test", timezone: "Europe/London" };
const ctx = { organizationId: org.id, userId: null };

const SOURCE = "700100"; // sachet trial product
const TARGET = "700200";
const TARGET_VARIANT = "700201";
const T0 = Date.parse("2026-11-01T10:00:00Z"); // all trial subs start here unless stated
const DAY = 86_400_000;
const at = (days: number) => new Date(T0 + days * DAY);

let integrationId = "";
let funnelId = "";

const rc = {
  subs: new Map<string, ConnectorSubscription>(),
  putCalls: 0,
  getCalls: 0,
  behaviour: "ok" as "ok" | "http422" | "timeout_after_put",
  tamper: null as ((s: ConnectorSubscription) => void) | null,
};
const mkSub = (ext: string, over: Partial<ConnectorSubscription> = {}): ConnectorSubscription => ({
  externalSubscriptionId: ext,
  externalCustomerId: `c-${ext}`,
  externalAddressId: `a-${ext}`,
  status: "active",
  providerStatus: "active",
  externalProductId: SOURCE,
  externalVariantId: "700101",
  productTitle: "Morning Magic Sachets",
  variantTitle: null,
  sku: null,
  quantity: 1,
  price: "2.99",
  intervalUnit: "day",
  intervalFrequency: 30,
  nextChargeDate: "2026-12-05",
  externalCreatedAt: new Date(T0),
  externalUpdatedAt: null,
  cancelledAt: null,
  providerData: null,
  ...over,
});
const fake = {
  getSubscription: async (id: string) => {
    rc.getCalls++;
    const s = rc.subs.get(id);
    if (!s) throw new RechargeError("NOT_FOUND", `subscription ${id} not found`, {});
    return { ...s };
  },
  swapSubscriptionProduct: async (id: string, body: RechargeSubscriptionSwapBody) => {
    rc.putCalls++;
    if (rc.behaviour === "http422") throw new RechargeError("VALIDATION_ERROR", "Recharge rejected the request as invalid", {});
    const s = rc.subs.get(id);
    if (!s) throw new RechargeError("NOT_FOUND", `subscription ${id} not found`, {});
    s.externalProductId = body.external_product_id.ecommerce;
    s.externalVariantId = body.external_variant_id.ecommerce;
    if (body.product_title) s.productTitle = body.product_title;
    if (body.price) s.price = body.price;
    if (rc.tamper) rc.tamper(s);
    if (rc.behaviour === "timeout_after_put") throw new RechargeError("NETWORK_ERROR", "socket hang up", {});
    return { ...s };
  },
} as unknown as RechargeConnector;

async function seedTrialSub(ext: string, opts: { startedAt?: Date; next?: string } = {}) {
  const startedAt = opts.startedAt ?? new Date(T0);
  const sub = await prisma.subscription.create({
    data: {
      organizationId: org.id,
      integrationId,
      externalSubscriptionId: ext,
      externalCustomerId: `c-${ext}`,
      externalAddressId: `a-${ext}`,
      status: "ACTIVE",
      externalProductId: SOURCE,
      externalVariantId: "700101",
      productTitleSnapshot: "Morning Magic Sachets",
      price: "2.99",
      nextChargeDate: opts.next ?? "2026-12-05",
      externalCreatedAt: startedAt,
    },
  });
  rc.subs.set(ext, mkSub(ext, { externalCreatedAt: startedAt, nextChargeDate: opts.next ?? "2026-12-05" }));
  return sub;
}

const sweep = (now: Date) => runTrialConversionSweep(ctx, funnelId, { connector: fake, now });
const cand = (ext: string) => prisma.trialConversionCandidate.findFirstOrThrow({ where: { organizationId: org.id, externalSubscriptionId: ext } });
const checkpointDaysOf = (c: { checkpointsJson: unknown }) => ((c.checkpointsJson as TrialCheckpoint[] | null) ?? []).map((p) => p.day).sort((a, b) => a - b);

beforeAll(async () => {
  await prisma.organization.create({ data: org });
  integrationId = (await prisma.integration.create({ data: { organizationId: org.id, provider: "RECHARGE", externalStoreId: `tc-${run}`, displayName: "TC Store", encryptedCredentials: "x", automationMode: "OFF", status: "CONNECTED" } })).id;
  funnelId = (
    await prisma.trialConversionFunnel.create({
      data: {
        organizationId: org.id,
        integrationId,
        name: "Sachets to Decaf Pouch",
        mode: "DRY_RUN",
        sourceExternalProductId: SOURCE,
        targetExternalProductId: TARGET,
        targetExternalVariantId: TARGET_VARIANT,
        targetProductTitle: "Morning Magic Decaf Pouch",
        targetPrice: "28.00",
        convertAfterDays: 7,
        checkpointDays: [2, 5, 6, 7],
      },
    })
  ).id;
  await seedTrialSub("TC-A");
  await seedTrialSub("TC-B");
  await seedTrialSub("TC-C");
  await seedTrialSub("TC-D");
});
afterAll(async () => {
  await prisma.organization.delete({ where: { id: org.id } });
  await prisma.$disconnect();
});

describe("enrolment and checkpoints (DRY_RUN)", () => {
  it("enrols active trial subs and records the day-2 cancellation check", async () => {
    const s = await sweep(at(2.5));
    expect(s.ok).toBe(true);
    expect(s.enrolled).toBe(4);
    expect(s.checked).toBe(4);
    expect(rc.putCalls).toBe(0);
    const a = await cand("TC-A");
    expect(a.status).toBe("WATCHING");
    expect(checkpointDaysOf(a)).toEqual([2]);
    expect(a.dueAt.getTime()).toBe(T0 + 7 * DAY);
  });

  it("a cancellation observed at the day-5 check is terminal — the sub is never converted", async () => {
    rc.subs.get("TC-B")!.status = "cancelled";
    rc.subs.get("TC-B")!.providerStatus = "cancelled";
    rc.subs.get("TC-B")!.cancelledAt = at(4);
    // TC-C: cancellation arrives via SYNCED data instead — terminal without an API call
    await prisma.subscription.updateMany({ where: { organizationId: org.id, externalSubscriptionId: "TC-C" }, data: { status: "CANCELLED" } });
    const before = rc.getCalls;
    const s = await sweep(at(5.1));
    expect(s.cancelledDetected).toBe(2);
    const b = await cand("TC-B");
    expect(b.status).toBe("CANCELLED");
    expect(((b.checkpointsJson as TrialCheckpoint[]) ?? []).find((p) => p.day === 5)?.outcome).toBe("cancelled");
    const c = await cand("TC-C");
    expect(c.status).toBe("CANCELLED");
    expect(c.detail).toContain("synced data");
    // only A and D were fetched live (B was fetched and found cancelled; C was killed from sync data)
    expect(rc.getCalls - before).toBe(3);
    expect(rc.putCalls).toBe(0);
  });

  it("day-6 check records; a manual swap outside the engine becomes ALREADY_CONVERTED", async () => {
    await sweep(at(6.1));
    expect(checkpointDaysOf(await cand("TC-A"))).toEqual([2, 5, 6]);
    // TC-D gets swapped manually (his guy's batch) before it is due
    rc.subs.get("TC-D")!.externalProductId = TARGET;
    rc.subs.get("TC-D")!.productTitle = "Morning Magic Decaf Pouch";
    const s = await sweep(at(7.2));
    expect(s.alreadyConverted).toBe(1);
    expect((await cand("TC-D")).status).toBe("ALREADY_CONVERTED");
    expect(rc.putCalls).toBe(0);
  });

  it("DRY_RUN: every check passed → WOULD_CONVERT, the write is withheld", async () => {
    const a = await cand("TC-A");
    expect(a.status).toBe("WOULD_CONVERT");
    expect(checkpointDaysOf(a)).toEqual([2, 5, 6, 7]);
    expect(rc.putCalls).toBe(0);
    const act = await prisma.activityLog.findFirst({ where: { organizationId: org.id, eventType: "TRIAL_WOULD_CONVERT", entityId: a.subscriptionId } });
    expect(act).toBeTruthy();
    // rerun: no duplicate transition activity, still zero writes
    await sweep(at(7.4));
    const acts = await prisma.activityLog.count({ where: { organizationId: org.id, eventType: "TRIAL_WOULD_CONVERT", entityId: a.subscriptionId } });
    expect(acts).toBe(1);
    expect(rc.putCalls).toBe(0);
  });
});

describe("LIVE conversion", () => {
  it("converts a WOULD_CONVERT candidate with exactly one verified PUT", async () => {
    await prisma.trialConversionFunnel.update({ where: { id: funnelId }, data: { mode: "LIVE" } });
    const s = await sweep(at(7.6));
    expect(s.converted).toBe(1);
    expect(rc.putCalls).toBe(1);
    const a = await cand("TC-A");
    expect(a.status).toBe("CONVERTED");
    expect(a.verifiedAt).toBeTruthy();
    expect(a.dryRun).toBe(false);
    expect(rc.subs.get("TC-A")!.externalProductId).toBe(TARGET);
    expect(rc.subs.get("TC-A")!.price).toBe("28.00");
    const act = await prisma.activityLog.findFirst({ where: { organizationId: org.id, eventType: "TRIAL_CONVERTED", entityId: a.subscriptionId } });
    expect(act?.summary).toContain("Morning Magic Decaf Pouch");
  });

  it("the FINAL fresh check catches a cancellation at the moment of execution — no write", async () => {
    await seedTrialSub("TC-E", { startedAt: at(-0.5) }); // already 8 days old when enrolled
    rc.subs.get("TC-E")!.status = "cancelled";
    rc.subs.get("TC-E")!.providerStatus = "cancelled";
    const puts = rc.putCalls;
    const s = await sweep(at(7.8));
    expect(s.enrolled).toBe(1);
    expect(s.cancelledDetected).toBe(1);
    expect((await cand("TC-E")).status).toBe("CANCELLED");
    expect(rc.putCalls).toBe(puts);
  });

  it("postpones inside the charge-race window, converts after the charge has passed", async () => {
    await seedTrialSub("TC-F", { startedAt: at(-1), next: "2026-11-08" }); // due; charge is 'today'
    let s = await sweep(new Date("2026-11-08T14:00:00Z"));
    expect(s.postponed).toBe(1);
    expect((await cand("TC-F")).status).toBe("WATCHING");
    rc.subs.get("TC-F")!.nextChargeDate = "2026-12-08";
    s = await sweep(new Date("2026-11-08T20:00:00Z"));
    expect(s.converted).toBe(1);
    expect((await cand("TC-F")).status).toBe("CONVERTED");
  });

  it("a far-out next charge (customer delayed) is held and flagged once, not converted", async () => {
    await seedTrialSub("TC-J", { startedAt: at(-1), next: "2027-02-15" });
    await sweep(at(8));
    await sweep(at(8.1));
    expect((await cand("TC-J")).status).toBe("WATCHING");
    const exes = await prisma.exception.count({ where: { organizationId: org.id, type: "TRIAL_CONVERSION_DELAYED_CHARGE" } });
    expect(exes).toBe(1);
  });

  it("an ambiguous PUT (write landed, response lost) reconciles by read — no second PUT", async () => {
    await seedTrialSub("TC-G", { startedAt: at(-1) });
    rc.behaviour = "timeout_after_put";
    const puts = rc.putCalls;
    const s = await sweep(at(8.2));
    rc.behaviour = "ok";
    expect(s.converted).toBe(1);
    expect(rc.putCalls - puts).toBe(1);
    expect((await cand("TC-G")).status).toBe("CONVERTED");
  });

  it("a definite rejection fails the candidate and raises an exception", async () => {
    await seedTrialSub("TC-H", { startedAt: at(-1) });
    rc.behaviour = "http422";
    const s = await sweep(at(8.4));
    rc.behaviour = "ok";
    expect(s.failed).toBe(1);
    expect((await cand("TC-H")).status).toBe("FAILED");
    const ex = await prisma.exception.findFirst({ where: { organizationId: org.id, type: "TRIAL_CONVERSION_FAILED" } });
    expect(ex?.description).toContain("TC-H");
  });

  it("a read-back mismatch fails the candidate with a CRITICAL exception", async () => {
    await seedTrialSub("TC-I", { startedAt: at(-1) });
    rc.tamper = (s) => {
      s.price = "2.99"; // provider kept the old price — the swap did not verify
    };
    const s = await sweep(at(8.6));
    rc.tamper = null;
    expect(s.failed).toBe(1);
    const i = await cand("TC-I");
    expect(i.status).toBe("FAILED");
    expect(i.lastError).toContain("price");
    const ex = await prisma.exception.findFirst({ where: { organizationId: org.id, type: "TRIAL_CONVERSION_FAILED", severity: "CRITICAL" } });
    expect(ex).toBeTruthy();
  });

  it("reruns are idempotent: nothing new happens, terminal candidates stay terminal", async () => {
    const puts = rc.putCalls;
    const s = await sweep(at(9));
    expect(s.enrolled).toBe(0);
    expect(s.converted).toBe(0);
    expect(rc.putCalls).toBe(puts);
    expect((await cand("TC-B")).status).toBe("CANCELLED");
    expect((await cand("TC-A")).status).toBe("CONVERTED");
  });

  it("LIVE without a configured target price refuses to run at all", async () => {
    await prisma.trialConversionFunnel.update({ where: { id: funnelId }, data: { targetPrice: null } });
    const s = await sweep(at(9.1));
    expect(s.ok).toBe(false);
    expect(s.error).toMatch(/target price/i);
    await prisma.trialConversionFunnel.update({ where: { id: funnelId }, data: { targetPrice: "28.00" } });
  });
});

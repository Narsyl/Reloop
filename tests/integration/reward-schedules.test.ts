/**
 * Reward schedules (Phase 4b): DB constraints, tenant identity of reward items, core validations,
 * and the legacy-rule migration keeping its audit history.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { dbFor } from "@/lib/db/tenant";
import { assignProgramSchedule, bindProgramMarker, migrateRuleToMilestone, setRewardScheduleStatus, upsertMilestone, upsertRewardItem, upsertRewardSchedule } from "@/lib/domain/rewards/core";
import { resolveProgramRewards } from "@/lib/domain/rewards/resolver";

const run = Math.random().toString(36).slice(2, 8);
const orgA = { id: `test_rsA_${run}`, slug: `test-rsa-${run}`, name: "RS A" };
const orgB = { id: `test_rsB_${run}`, slug: `test-rsb-${run}`, name: "RS B" };
const A = { organizationId: orgA.id };
const B = { organizationId: orgB.id };
let integrationId = "";
let programId = "";
let markerWhisk = "";
let whisk = "";
let cup = "";
let schedule = "";
function ok<T>(r: { ok: true; data?: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.data as T;
}

beforeAll(async () => {
  await prisma.organization.createMany({ data: [orgA, orgB] });
  const integ = await prisma.integration.create({ data: { ...A, provider: "RECHARGE", externalStoreId: `s-${run}`, displayName: "Fake", encryptedCredentials: "x", automationMode: "OFF" } });
  integrationId = integ.id;
  const prod = await prisma.product.create({ data: { ...A, integrationId, externalProductId: "8001", title: "MM" } });
  await prisma.productVariant.create({ data: { ...A, productId: prod.id, externalVariantId: "9001", title: "1" } });
  const prog = await prisma.subscriptionProgram.create({ data: { ...A, name: "Morning Magic Powder" } });
  programId = prog.id;
  await prisma.subscriptionProgramProduct.create({ data: { ...A, programId, productId: prod.id, variantId: null, variantScope: "*" } });
  whisk = ok(await upsertRewardItem(A, { name: "Whisk" })).id;
  cup = ok(await upsertRewardItem(A, { name: "Cup" })).id;
  const mkp = await prisma.product.create({ data: { ...A, integrationId, externalProductId: "mk-1", title: "Morning Magic 2", type: "FULFILMENT_MARKER" } });
  const mkv = await prisma.productVariant.create({ data: { ...A, productId: mkp.id, externalVariantId: "77001", title: "Morning Magic 2", price: "0.00" } });
  markerWhisk = (await prisma.fulfillmentMarker.create({ data: { ...A, integrationId, name: "Morning Magic 2", variantId: mkv.id, externalVariantId: "77001", title: "Morning Magic 2", source: "MANUAL", rewardItemId: whisk } })).id;
  schedule = ok(await upsertRewardSchedule(A, { name: "Schedule A" })).id;
});
afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  await prisma.$disconnect();
});

describe("reward items", () => {
  it("are unique per organisation by name, and a second organisation can use the same name without seeing the first", async () => {
    const dup = await upsertRewardItem(A, { name: "Whisk" });
    expect(dup.ok).toBe(false);
    const other = ok(await upsertRewardItem(B, { name: "Whisk" }));
    expect(other.id).not.toBe(whisk);
    expect(await dbFor(B).rewardItem.count()).toBe(1);
    expect(await dbFor(A).rewardItem.count()).toBe(2);
    expect(await dbFor(B).rewardItem.findUnique({ where: { id: whisk } })).toBeNull();
  });
});

describe("schedule + milestone constraints", () => {
  it("one milestone per delivery number per schedule; cycle 1 equals INITIAL_CHECKOUT is enforced by the database", async () => {
    const m2 = ok(await upsertMilestone(A, { scheduleId: schedule, cycleNumber: 2, rewardItemId: whisk, eligibilityScope: "CUSTOMER_PROGRAM" }));
    expect(m2.id).toBeTruthy();
    const dup = await upsertMilestone(A, { scheduleId: schedule, cycleNumber: 2, rewardItemId: cup, eligibilityScope: "CUSTOMER_PROGRAM" });
    expect(dup.ok).toBe(false);
    const m1 = ok(await upsertMilestone(A, { scheduleId: schedule, cycleNumber: 1, rewardItemId: whisk, eligibilityScope: "CUSTOMER_PROGRAM" }));
    expect((await prisma.rewardScheduleMilestone.findUniqueOrThrow({ where: { id: m1.id } })).executionMode).toBe("INITIAL_CHECKOUT");
    await expect(prisma.rewardScheduleMilestone.create({ data: { ...A, scheduleId: schedule, cycleNumber: 3, rewardItemId: cup, executionMode: "INITIAL_CHECKOUT", eligibilityScope: "CUSTOMER_PROGRAM" } })).rejects.toThrow();
    await expect(prisma.rewardScheduleMilestone.create({ data: { ...A, scheduleId: schedule, cycleNumber: 1, rewardItemId: cup, executionMode: "UPCOMING_RENEWAL", eligibilityScope: "CUSTOMER_PROGRAM" } })).rejects.toThrow();
    expect((await upsertMilestone(A, { scheduleId: schedule, cycleNumber: 0, rewardItemId: whisk, eligibilityScope: "CUSTOMER_PROGRAM" })).ok).toBe(false);
  });
  it("READY requires an active milestone; bindings require assignment, a reward item on the marker, and a matching reward; one binding per programme+milestone", async () => {
    const empty = ok(await upsertRewardSchedule(A, { name: "Empty" })).id;
    expect((await setRewardScheduleStatus(A, empty, "READY")).ok).toBe(false);
    const m2 = (await prisma.rewardScheduleMilestone.findFirstOrThrow({ where: { scheduleId: schedule, cycleNumber: 2 } })).id;
    expect((await bindProgramMarker(A, { programId, milestoneId: m2, fulfillmentMarkerId: markerWhisk })).ok).toBe(false); // not assigned yet
    ok(await assignProgramSchedule(A, { programId, scheduleId: schedule }));
    const variant = await prisma.productVariant.findFirstOrThrow({ where: { externalVariantId: "9001", organizationId: orgA.id } });
    const noItem = await prisma.fulfillmentMarker.create({ data: { ...A, integrationId, name: "No reward", variantId: variant.id, externalVariantId: "9001", title: "x", source: "MANUAL" } });
    expect((await bindProgramMarker(A, { programId, milestoneId: m2, fulfillmentMarkerId: noItem.id })).ok).toBe(false); // no reward item on marker
    await prisma.fulfillmentMarker.update({ where: { id: noItem.id }, data: { rewardItemId: cup } });
    expect((await bindProgramMarker(A, { programId, milestoneId: m2, fulfillmentMarkerId: noItem.id })).ok).toBe(false); // cup marker on whisk milestone
    ok(await bindProgramMarker(A, { programId, milestoneId: m2, fulfillmentMarkerId: markerWhisk }));
    expect(await prisma.programMilestoneMarker.count({ where: { programId, rewardScheduleMilestoneId: m2 } })).toBe(1);
    ok(await bindProgramMarker(A, { programId, milestoneId: m2, fulfillmentMarkerId: markerWhisk })); // rebinding updates the same row
    expect(await prisma.programMilestoneMarker.count({ where: { programId, rewardScheduleMilestoneId: m2 } })).toBe(1);
    await expect(prisma.programMilestoneMarker.create({ data: { ...A, programId, rewardScheduleMilestoneId: m2, fulfillmentMarkerId: markerWhisk } })).rejects.toThrow();
    expect((await bindProgramMarker(B, { programId, milestoneId: m2, fulfillmentMarkerId: markerWhisk })).ok).toBe(false); // cross-tenant
    ok(await setRewardScheduleStatus(A, schedule, "READY"));
    const view = await resolveProgramRewards(A, programId);
    expect(view.milestones.map((m) => [m.cycleNumber, m.readiness])).toEqual([[1, "INITIAL_CHECKOUT_NOT_PLANNED"], [2, "READY"]]);
  });
});

describe("legacy rule migration", () => {
  it("archives the rule, links it to the milestone, and keeps every RULE activity row", async () => {
    const rule = await prisma.automationRule.create({ data: { ...A, name: "MM delivery 2 (legacy)", status: "DRAFT", eligibilityScope: "CUSTOMER_PROGRAM", milestoneKey: `${orgA.id}:${programId}:2`, programId, cycleNumber: 2, fulfillmentMarkerId: markerWhisk } });
    await prisma.activityLog.createMany({
      data: [
        { ...A, actorType: "USER", eventType: "RULE_CREATED", entityType: "RULE", entityId: rule.id, summary: "created" },
        { ...A, actorType: "USER", eventType: "RULE_UPDATED", entityType: "RULE", entityId: rule.id, summary: "scope set" },
      ],
    });
    const m2 = (await prisma.rewardScheduleMilestone.findFirstOrThrow({ where: { scheduleId: schedule, cycleNumber: 2 } })).id;
    ok(await migrateRuleToMilestone(A, { ruleId: rule.id, milestoneId: m2 }));
    const after = await prisma.automationRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(after.status).toBe("ARCHIVED");
    expect(after.milestoneKey).toBeNull();
    expect(after.migratedToMilestoneId).toBe(m2);
    const rows = await prisma.activityLog.findMany({ where: { entityType: "RULE", entityId: rule.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.eventType)).toEqual(["RULE_CREATED", "RULE_UPDATED", "RULE_MIGRATED_TO_SCHEDULE"]);
  });
});

/**
 * Database-level guarantees for Phase 3 configuration:
 *  - one V1 milestone rule per (organisation, programme, cycle) via milestoneKey
 *  - archived rules free the milestone
 *  - cycleNumber >= 2 enforced by the DB check constraint
 *  - marker identity: one marker per variant; (integration, externalVariantId) unique
 *  - latestJourneyId rename preserved journey linkage
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { milestoneKey } from "@/lib/domain/rules/validation";

const run = Math.random().toString(36).slice(2, 8);
const org = { id: `test_rm_${run}`, slug: `test-rm-${run}`, name: "Rules Test" };
let integrationId = "", integration2Id = "", programId = "", markerId = "", variantId = "", variant2Id = "";

beforeAll(async () => {
  await prisma.organization.create({ data: org });
  const i1 = await prisma.integration.create({ data: { organizationId: org.id, provider: "RECHARGE", externalStoreId: `s1-${run}`, displayName: "Store 1", encryptedCredentials: "x" } });
  const i2 = await prisma.integration.create({ data: { organizationId: org.id, provider: "RECHARGE", externalStoreId: `s2-${run}`, displayName: "Store 2", encryptedCredentials: "x" } });
  integrationId = i1.id; integration2Id = i2.id;
  const p = await prisma.product.create({ data: { organizationId: org.id, integrationId, externalProductId: "mk-prod", title: "Morning Magic 2", type: "FULFILMENT_MARKER" } });
  const v = await prisma.productVariant.create({ data: { organizationId: org.id, productId: p.id, externalVariantId: "123456", title: "Default", sku: "MM-CYCLE-02" } });
  variantId = v.id;
  const p2 = await prisma.product.create({ data: { organizationId: org.id, integrationId: integration2Id, externalProductId: "mk-prod", title: "Morning Magic 2 (store 2)", type: "FULFILMENT_MARKER" } });
  const v2 = await prisma.productVariant.create({ data: { organizationId: org.id, productId: p2.id, externalVariantId: "123456", title: "Default" } });
  variant2Id = v2.id;
  const prog = await prisma.subscriptionProgram.create({ data: { organizationId: org.id, name: "Morning Magic Powder" } });
  programId = prog.id;
  const m = await prisma.fulfillmentMarker.create({ data: { organizationId: org.id, integrationId, name: "Morning Magic Cycle 2", variantId, externalVariantId: "123456", externalProductId: "mk-prod", title: "Morning Magic 2", sku: "MM-CYCLE-02", source: "DISCOVERED_ONETIME" } });
  markerId = m.id;
});
afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: org.id } });
  await prisma.$disconnect();
});

describe("rule milestone uniqueness + cycle floor", () => {
  it("creates a draft rule and rejects a second rule for the same programme + cycle, regardless of marker", async () => {
    const r1 = await prisma.automationRule.create({ data: { organizationId: org.id, name: "MM delivery 2", programId, cycleNumber: 2, fulfillmentMarkerId: markerId, milestoneKey: milestoneKey(org.id, programId, 2), status: "DRAFT" } });
    expect(r1.status).toBe("DRAFT");
    await expect(
      prisma.automationRule.create({ data: { organizationId: org.id, name: "MM delivery 2 (competing)", programId, cycleNumber: 2, fulfillmentMarkerId: markerId, milestoneKey: milestoneKey(org.id, programId, 2), status: "DRAFT" } }),
    ).rejects.toThrow(/milestoneKey/);
  });
  it("archiving frees the milestone for a new rule", async () => {
    const existing = await prisma.automationRule.findFirstOrThrow({ where: { organizationId: org.id, cycleNumber: 2 } });
    await prisma.automationRule.update({ where: { id: existing.id }, data: { status: "ARCHIVED", milestoneKey: null } });
    const r2 = await prisma.automationRule.create({ data: { organizationId: org.id, name: "MM delivery 2 v2", programId, cycleNumber: 2, fulfillmentMarkerId: markerId, milestoneKey: milestoneKey(org.id, programId, 2), status: "READY", eligibilityScope: "PER_SUBSCRIPTION" } });
    expect(r2.status).toBe("READY");
  });
  it("cycle 1 is rejected by the database check constraint", async () => {
    await expect(
      prisma.automationRule.create({ data: { organizationId: org.id, name: "MM delivery 1", programId, cycleNumber: 1, fulfillmentMarkerId: markerId, milestoneKey: milestoneKey(org.id, programId, 1), status: "DRAFT" } }),
    ).rejects.toThrow(/cycleNumber_min_check|check constraint/i);
  });
});

describe("marker identity scoping", () => {
  it("one marker per variant", async () => {
    await expect(prisma.fulfillmentMarker.create({ data: { organizationId: org.id, integrationId, name: "Duplicate of MM2", variantId, externalVariantId: "123456", title: "Morning Magic 2" } })).rejects.toThrow();
  });
  it("the same numeric Shopify variant id is a DIFFERENT identity on another integration", async () => {
    const m2 = await prisma.fulfillmentMarker.create({ data: { organizationId: org.id, integrationId: integration2Id, name: "Store 2 MM2", variantId: variant2Id, externalVariantId: "123456", title: "Morning Magic 2" } });
    expect(m2.integrationId).toBe(integration2Id);
    // but within ONE integration the external variant id is unique
    const pX = await prisma.product.create({ data: { organizationId: org.id, integrationId, externalProductId: "another", title: "Another" } });
    const vX = await prisma.productVariant.create({ data: { organizationId: org.id, productId: pX.id, externalVariantId: "123456", title: "Default" } });
    await expect(prisma.fulfillmentMarker.create({ data: { organizationId: org.id, integrationId, name: "Clash", variantId: vX.id, externalVariantId: "123456", title: "x" } })).rejects.toThrow(/externalVariantId/);
  });
});

describe("latestJourneyId rename", () => {
  it("is the renamed column and still links journeys", async () => {
    const cust = await prisma.customer.create({ data: { organizationId: org.id, integrationId, externalCustomerId: "c1" } });
    const sub = await prisma.subscription.create({ data: { organizationId: org.id, integrationId, customerId: cust.id, externalSubscriptionId: "s1", externalCustomerId: "c1", externalAddressId: "a1", externalProductId: "p", externalVariantId: "v", productTitleSnapshot: "P", status: "ACTIVE" } });
    const j = await prisma.subscriptionJourney.create({ data: { organizationId: org.id, subscriptionId: sub.id, programId, externalProductId: "p", externalVariantId: "v", sequence: 1, startedAt: new Date() } });
    const updated = await prisma.subscription.update({ where: { id: sub.id }, data: { latestJourneyId: j.id }, include: { latestJourney: true } });
    expect(updated.latestJourney?.id).toBe(j.id);
    const back = await prisma.subscriptionJourney.findUniqueOrThrow({ where: { id: j.id }, include: { latestOf: true } });
    expect(back.latestOf?.id).toBe(sub.id);
  });
});

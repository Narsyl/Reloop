/**
 * Cross-tenant isolation: for every tenant-owned model, a row created in org A
 * must be invisible and unwritable through org B's scoped client, and creates
 * through a scoped client must land in that client's organisation.
 *
 * Runs against the database in .env.local. All rows are created under two
 * throwaway organisations and removed afterwards (cascade).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { TENANT_MODELS, createTenantClient, type TenantModelName } from "@/lib/db/tenant";

const run = Math.random().toString(36).slice(2, 8);
const orgA = { id: `test_orgA_${run}`, slug: `test-a-${run}`, name: "Test Org A" };
const orgB = { id: `test_orgB_${run}`, slug: `test-b-${run}`, name: "Test Org B" };

type Fixture = { model: TenantModelName; ids: { A: string; B: string } };
const fixtures: Fixture[] = [];

/** Builds one row per tenant model for an org, returning ids keyed by model. */
async function seedOrg(org: { id: string; slug: string; name: string }, userId: string) {
  const ids: Partial<Record<TenantModelName, string>> = {};
  await prisma.organization.create({ data: org });

  const m = await prisma.organizationMembership.create({
    data: { organizationId: org.id, userId, role: "OWNER" },
  });
  ids.OrganizationMembership = m.id;

  const integ = await prisma.integration.create({
    data: {
      organizationId: org.id,
      provider: "RECHARGE",
      externalStoreId: `store-${org.slug}`,
      displayName: org.name,
      encryptedCredentials: "v1.test.x.y.z",
    },
  });
  ids.Integration = integ.id;

  const cust = await prisma.customer.create({
    data: { organizationId: org.id, integrationId: integ.id, externalCustomerId: "c1", email: "a@b.c" },
  });
  ids.Customer = cust.id;

  const prod = await prisma.product.create({
    data: { organizationId: org.id, integrationId: integ.id, externalProductId: "p1", title: "Prod" },
  });
  ids.Product = prod.id;

  const variant = await prisma.productVariant.create({
    data: { organizationId: org.id, productId: prod.id, externalVariantId: "v1", title: "Default" },
  });
  ids.ProductVariant = variant.id;

  const program = await prisma.subscriptionProgram.create({
    data: { organizationId: org.id, name: "Program" },
  });
  ids.SubscriptionProgram = program.id;

  const pp = await prisma.subscriptionProgramProduct.create({
    data: { organizationId: org.id, programId: program.id, productId: prod.id },
  });
  ids.SubscriptionProgramProduct = pp.id;

  const marker = await prisma.fulfillmentMarker.create({
    data: { organizationId: org.id, integrationId: integ.id, name: "Marker", variantId: variant.id, externalVariantId: variant.externalVariantId, externalProductId: "p1", title: "Marker item", sku: "MK-1", source: "MANUAL" },
  });
  ids.FulfillmentMarker = marker.id;

  const sub = await prisma.subscription.create({
    data: {
      organizationId: org.id,
      integrationId: integ.id,
      customerId: cust.id,
      externalSubscriptionId: "s1",
      externalCustomerId: "c1",
      externalAddressId: "a1",
      externalProductId: "p1",
      externalVariantId: "v1",
      productTitleSnapshot: "Prod",
      productId: prod.id,
      variantId: variant.id,
      status: "ACTIVE",
    },
  });
  ids.Subscription = sub.id;

  const journey = await prisma.subscriptionJourney.create({
    data: {
      organizationId: org.id,
      subscriptionId: sub.id,
      programId: program.id,
      productId: prod.id,
      externalProductId: "p1",
      externalVariantId: "v1",
      sequence: 1,
      startedAt: new Date(),
    },
  });
  ids.SubscriptionJourney = journey.id;
  await prisma.subscription.update({ where: { id: sub.id }, data: { latestJourneyId: journey.id } });

  const cycle = await prisma.journeyCycle.create({
    data: {
      organizationId: org.id,
      journeyId: journey.id,
      cycleNumber: 1,
      externalOrderId: "o1",
      orderKind: "CHECKOUT",
      processedAt: new Date(),
      source: "BACKFILL",
    },
  });
  ids.JourneyCycle = cycle.id;

  const rule = await prisma.automationRule.create({
    data: {
      organizationId: org.id,
      name: "Rule",
      programId: program.id,
      cycleNumber: 2,
      fulfillmentMarkerId: marker.id,
    },
  });
  ids.AutomationRule = rule.id;

  const action = await prisma.automationAction.create({
    data: {
      organizationId: org.id,
      integrationId: integ.id,
      ruleId: rule.id,
      subscriptionId: sub.id,
      journeyId: journey.id,
      fulfillmentMarkerId: marker.id,
      targetCycle: 2,
      liveKey: `${journey.id}:2:${marker.id}`,
    },
  });
  ids.AutomationAction = action.id;

  const event = await prisma.integrationEvent.create({
    data: {
      organizationId: org.id,
      integrationId: integ.id,
      provider: "RECHARGE",
      eventType: "order/processed",
      dedupeKey: `k-${org.slug}`,
      payloadJson: {},
      signatureValid: true,
    },
  });
  ids.IntegrationEvent = event.id;

  const exc = await prisma.exception.create({
    data: {
      organizationId: org.id,
      severity: "WARNING",
      type: "TEST",
      title: "t",
      description: "d",
    },
  });
  ids.Exception = exc.id;

  const log = await prisma.activityLog.create({
    data: {
      organizationId: org.id,
      actorType: "SYSTEM",
      eventType: "TEST",
      entityType: "ORGANIZATION",
      entityId: org.id,
      summary: "test",
    },
  });
  ids.ActivityLog = log.id;

  const syncRun = await prisma.integrationSync.create({
    data: { organizationId: org.id, integrationId: integ.id, kind: "INITIAL", status: "COMPLETED", stage: "COMPLETE" },
  });
  ids.IntegrationSync = syncRun.id;

  const so = await prisma.subscriptionOrder.create({
    data: {
      organizationId: org.id,
      integrationId: integ.id,
      subscriptionId: sub.id,
      externalSubscriptionId: "s1",
      externalOrderId: "o1",
      orderKind: "CHECKOUT",
      orderStatus: "success",
      processedAt: new Date(),
      externalProductId: "p1",
      externalVariantId: "v1",
    },
  });
  ids.SubscriptionOrder = so.id;

  return ids as Record<TenantModelName, string>;
}

function delegate(client: ReturnType<typeof createTenantClient>, model: TenantModelName) {
  const key = (model.charAt(0).toLowerCase() + model.slice(1)) as Uncapitalize<TenantModelName>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (client as any)[key] as {
    findUnique: (a: unknown) => Promise<unknown>;
    findMany: (a?: unknown) => Promise<unknown[]>;
    count: (a?: unknown) => Promise<number>;
    updateMany: (a: unknown) => Promise<{ count: number }>;
    deleteMany: (a: unknown) => Promise<{ count: number }>;
  };
}

let userId = "";

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `tenant-test-${run}@example.test`, name: "Tenant Test" },
  });
  userId = user.id;
  const idsA = await seedOrg(orgA, userId);
  const idsB = await seedOrg(orgB, userId);
  for (const model of TENANT_MODELS) {
    fixtures.push({ model, ids: { A: idsA[model], B: idsB[model] } });
  }
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("tenant isolation via dbFor()", () => {
  it("covers every tenant model listed in schema.prisma", () => {
    const schemaModels = Prisma.dmmf.datamodel.models
      .filter((m) => m.fields.some((f) => f.name === "organizationId"))
      .map((m) => m.name)
      .sort();
    expect([...TENANT_MODELS].sort()).toEqual(schemaModels);
  });

  for (const model of TENANT_MODELS) {
    describe(model, () => {
      it("org B cannot read org A's row by id", async () => {
        const f = fixtures.find((x) => x.model === model)!;
        const dbB = createTenantClient(orgB.id);
        const byId = await delegate(dbB, model).findUnique({ where: { id: f.ids.A } });
        expect(byId).toBeNull();
        const all = (await delegate(dbB, model).findMany()) as { id: string }[];
        expect(all.map((r) => r.id)).not.toContain(f.ids.A);
        expect(all.map((r) => r.id)).toContain(f.ids.B);
      });

      it("org B cannot update or delete org A's row", async () => {
        const f = fixtures.find((x) => x.model === model)!;
        const dbB = createTenantClient(orgB.id);
        const upd = await delegate(dbB, model).updateMany({ where: { id: f.ids.A }, data: {} });
        expect(upd.count).toBe(0);
        const del = await delegate(dbB, model).deleteMany({ where: { id: f.ids.A } });
        expect(del.count).toBe(0);
        // still there for org A
        const dbA = createTenantClient(orgA.id);
        expect(await delegate(dbA, model).findUnique({ where: { id: f.ids.A } })).not.toBeNull();
      });

      it("org A counts only its own rows", async () => {
        const dbA = createTenantClient(orgA.id);
        const n = await delegate(dbA, model).count();
        expect(n).toBe(1);
      });
    });
  }

  it("create through a scoped client lands in that organisation even if the caller lies", async () => {
    const dbB = createTenantClient(orgB.id);
    const created = await dbB.activityLog.create({
      data: {
        organizationId: orgA.id, // attacker-supplied; must be overridden
        actorType: "SYSTEM",
        eventType: "TEST_CREATE",
        entityType: "ORGANIZATION",
        entityId: "x",
        summary: "scoped create",
      },
    });
    expect(created.organizationId).toBe(orgB.id);
  });
});

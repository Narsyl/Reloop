/**
 * Program-mapping ambiguity invariant (Phase 2 constraint 1).
 *
 * For any (organisation, product, variant), resolution returns 0 or 1 program —
 * never 2. Enforced by the DB trigger + unique index; verified here end-to-end
 * through Prisma and through buildProgramResolver().
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { buildProgramResolver, isResolved } from "@/lib/domain/programs/resolve";

const run = Math.random().toString(36).slice(2, 8);
const orgA = { id: `test_pm_a_${run}`, slug: `test-pm-a-${run}`, name: "PM Test A" };
const orgB = { id: `test_pm_b_${run}`, slug: `test-pm-b-${run}`, name: "PM Test B" };

type Fixture = {
  org: typeof orgA;
  integrationId: string;
  products: { mm: string; kcups: string };
  variants: { mm30: string; mm60: string; k12: string; k24: string };
  programs: { powder: string; pods: string };
};

async function seed(org: typeof orgA): Promise<Fixture> {
  await prisma.organization.create({ data: org });
  const integ = await prisma.integration.create({
    data: { organizationId: org.id, provider: "RECHARGE", externalStoreId: `store-${org.slug}`, displayName: org.name, encryptedCredentials: "x" },
  });
  const O = { organizationId: org.id };
  const mm = await prisma.product.create({ data: { ...O, integrationId: integ.id, externalProductId: "ext-mm", title: "Morning Magic" } });
  const kcups = await prisma.product.create({ data: { ...O, integrationId: integ.id, externalProductId: "ext-k", title: "K-Cups" } });
  const mm30 = await prisma.productVariant.create({ data: { ...O, productId: mm.id, externalVariantId: "ext-mm-30", title: "30" } });
  const mm60 = await prisma.productVariant.create({ data: { ...O, productId: mm.id, externalVariantId: "ext-mm-60", title: "60" } });
  const k12 = await prisma.productVariant.create({ data: { ...O, productId: kcups.id, externalVariantId: "ext-k-12", title: "12" } });
  const k24 = await prisma.productVariant.create({ data: { ...O, productId: kcups.id, externalVariantId: "ext-k-24", title: "24" } });
  const powder = await prisma.subscriptionProgram.create({ data: { ...O, name: "Powder" } });
  const pods = await prisma.subscriptionProgram.create({ data: { ...O, name: "Pods" } });
  return { org, integrationId: integ.id, products: { mm: mm.id, kcups: kcups.id }, variants: { mm30: mm30.id, mm60: mm60.id, k12: k12.id, k24: k24.id }, programs: { powder: powder.id, pods: pods.id } };
}

const mapAll = (f: Fixture, programId: string, productId: string) =>
  prisma.subscriptionProgramProduct.create({ data: { organizationId: f.org.id, programId, productId, variantId: null, variantScope: "*" } });
const mapVariant = (f: Fixture, programId: string, productId: string, variantId: string) =>
  prisma.subscriptionProgramProduct.create({ data: { organizationId: f.org.id, programId, productId, variantId, variantScope: variantId } });

let A: Fixture;
let B: Fixture;

beforeAll(async () => {
  A = await seed(orgA);
  B = await seed(orgB);
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  await prisma.$disconnect();
});

describe("SubscriptionProgramProduct mapping invariant", () => {
  it("one product mapped entirely (all variants) to one program resolves every variant to it", async () => {
    await mapAll(A, A.programs.powder, A.products.mm);
    const r = await buildProgramResolver({ organizationId: A.org.id }, A.integrationId);
    for (const v of ["ext-mm-30", "ext-mm-60", null]) {
      const res = r.resolve("ext-mm", v);
      expect(isResolved(res) && res.programId).toBe(A.programs.powder);
      expect(isResolved(res) && res.via).toBe("ALL_VARIANTS");
    }
  });

  it("attempted specific-variant mapping when an ALL mapping exists is rejected", async () => {
    await expect(mapVariant(A, A.programs.pods, A.products.mm, A.variants.mm30)).rejects.toThrow(/PROGRAM_MAPPING_AMBIGUOUS/);
    // even to the SAME program — the model is all-or-specific, never both
    await expect(mapVariant(A, A.programs.powder, A.products.mm, A.variants.mm30)).rejects.toThrow(/PROGRAM_MAPPING_AMBIGUOUS/);
  });

  it("multiple individual variants of one product can map to the same program", async () => {
    await mapVariant(A, A.programs.pods, A.products.kcups, A.variants.k12);
    await mapVariant(A, A.programs.pods, A.products.kcups, A.variants.k24);
    const r = await buildProgramResolver({ organizationId: A.org.id }, A.integrationId);
    const a = r.resolve("ext-k", "ext-k-12");
    const b = r.resolve("ext-k", "ext-k-24");
    expect(isResolved(a) && a.programId).toBe(A.programs.pods);
    expect(isResolved(b) && b.programId).toBe(A.programs.pods);
    expect(isResolved(a) && a.via).toBe("VARIANT");
  });

  it("attempted ALL mapping when specific mappings exist is rejected", async () => {
    await expect(mapAll(A, A.programs.pods, A.products.kcups)).rejects.toThrow(/PROGRAM_MAPPING_AMBIGUOUS/);
    await expect(mapAll(A, A.programs.powder, A.products.kcups)).rejects.toThrow(/PROGRAM_MAPPING_AMBIGUOUS/);
  });

  it("the same variant cannot be mapped twice (unique index)", async () => {
    await expect(mapVariant(A, A.programs.powder, A.products.kcups, A.variants.k12)).rejects.toThrow();
  });

  it("different variants of one product may map to different programs (variant-level model permits it)", async () => {
    // move k24 to the Powder program (remove then re-add)
    await prisma.subscriptionProgramProduct.deleteMany({ where: { organizationId: A.org.id, variantId: A.variants.k24 } });
    await mapVariant(A, A.programs.powder, A.products.kcups, A.variants.k24);
    const r = await buildProgramResolver({ organizationId: A.org.id }, A.integrationId);
    const k12 = r.resolve("ext-k", "ext-k-12");
    const k24 = r.resolve("ext-k", "ext-k-24");
    expect(isResolved(k12) && k12.programId).toBe(A.programs.pods);
    expect(isResolved(k24) && k24.programId).toBe(A.programs.powder);
    // the product with NO variant given (unknown variant) is unmapped, not ambiguous
    const none = r.resolve("ext-k", "ext-k-99");
    expect(isResolved(none)).toBe(false);
  });

  it("variantScope must agree with variantId (defensive CHECK in trigger)", async () => {
    await expect(
      prisma.subscriptionProgramProduct.create({ data: { organizationId: A.org.id, programId: A.programs.powder, productId: A.products.mm, variantId: null, variantScope: "something" } }),
    ).rejects.toThrow(/PROGRAM_MAPPING_INVALID|PROGRAM_MAPPING_AMBIGUOUS/);
  });

  it("cross-tenant: identical products/mappings in another organisation remain valid and isolated", async () => {
    // org B maps the same external product ids in the opposite shape — no interference
    await mapVariant(B, B.programs.powder, B.products.mm, B.variants.mm30);
    await mapVariant(B, B.programs.pods, B.products.mm, B.variants.mm60);
    await mapAll(B, B.programs.pods, B.products.kcups);
    const rB = await buildProgramResolver({ organizationId: B.org.id }, B.integrationId);
    const rA = await buildProgramResolver({ organizationId: A.org.id }, A.integrationId);
    const b30 = rB.resolve("ext-mm", "ext-mm-30");
    const b60 = rB.resolve("ext-mm", "ext-mm-60");
    expect(isResolved(b30) && b30.programId).toBe(B.programs.powder);
    expect(isResolved(b60) && b60.programId).toBe(B.programs.pods);
    const a30 = rA.resolve("ext-mm", "ext-mm-30");
    expect(isResolved(a30) && a30.programId).toBe(A.programs.powder); // A unchanged
    // org A's resolver knows nothing about org B's programs
    expect(rA.mappingCount).toBe(3);
    expect(rB.mappingCount).toBe(3);
  });

  it("unknown product and unmapped product are distinguishable failures", async () => {
    const r = await buildProgramResolver({ organizationId: A.org.id }, A.integrationId);
    const unknown = r.resolve("does-not-exist", null);
    expect(!isResolved(unknown) && unknown.reason).toBe("UNKNOWN_PRODUCT");
    const p = await prisma.product.create({ data: { organizationId: A.org.id, integrationId: A.integrationId, externalProductId: "ext-ube", title: "Ube" } });
    const r2 = await buildProgramResolver({ organizationId: A.org.id }, A.integrationId);
    const unmapped = r2.resolve("ext-ube", null);
    expect(!isResolved(unmapped) && unmapped.reason).toBe("UNMAPPED");
    expect(!isResolved(unmapped) && unmapped.productId).toBe(p.id);
  });
});

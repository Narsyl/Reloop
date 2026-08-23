import { describe, expect, it } from "vitest";
import { computeJourneys, type CurrentState, type OrderFact, type ResolveFn } from "@/lib/domain/journeys/compute";

const d = (s: string) => new Date(s);
const MM = { programId: "prog_mm", productId: "p_mm" };
const CACAO = { programId: "prog_cacao", productId: "p_cacao" };

/** product ext id → program; variant "v-unmapped" of MM is deliberately unmapped */
const resolve: ResolveFn = (p, v) => {
  if (p === "mm") return v === "v-unmapped" ? null : { ...MM, variantId: v ? `var_${v}` : null };
  if (p === "cacao") return { ...CACAO, variantId: v ? `var_${v}` : null };
  return null;
};
const catalogue = (p: string, v: string | null) => ({ productId: p === "mm" ? "p_mm" : p === "cacao" ? "p_cacao" : null, variantId: v ? `var_${v}` : null });

const order = (id: string, at: string, product: string, variant = "v1", kind: "CHECKOUT" | "RECURRING" = "RECURRING"): OrderFact => ({
  externalOrderId: id,
  processedAt: d(at),
  orderKind: kind,
  externalProductId: product,
  externalVariantId: variant,
});

const current = (over: Partial<CurrentState> = {}): CurrentState => ({
  status: "ACTIVE",
  externalProductId: "mm",
  externalVariantId: "v1",
  externalCreatedAt: d("2026-01-01"),
  cancelledAt: null,
  asOf: d("2026-08-21"),
  ...over,
});

describe("computeJourneys", () => {
  it("counts checkout + recurring orders as cycles 1..n in one journey", () => {
    const r = computeJourneys([order("o1", "2026-01-01", "mm", "v1", "CHECKOUT"), order("o2", "2026-02-01", "mm"), order("o3", "2026-03-01", "mm")], current(), resolve, catalogue);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].cycles.map((c) => c.cycleNumber)).toEqual([1, 2, 3]);
    expect(r.segments[0].cycles[0].orderKind).toBe("CHECKOUT");
    expect(r.currentIndex).toBe(0);
    expect(r.mappingStatus).toBe("MAPPED");
    expect(r.segments[0].endedAt).toBeNull();
  });

  it("orders out of input order are sorted by processedAt before numbering", () => {
    const r = computeJourneys([order("o3", "2026-03-01", "mm"), order("o1", "2026-01-01", "mm"), order("o2", "2026-02-01", "mm")], current(), resolve, catalogue);
    expect(r.segments[0].cycles.map((c) => c.externalOrderId)).toEqual(["o1", "o2", "o3"]);
  });

  it("variant change within the same program keeps the journey and the count", () => {
    const r = computeJourneys([order("o1", "2026-01-01", "mm", "30"), order("o2", "2026-02-01", "mm", "60")], current({ externalVariantId: "60" }), resolve, catalogue);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].cycles).toHaveLength(2);
    expect(r.segments[0].variantId).toBe("var_60");
  });

  it("program change ends the journey (PROGRAM_CHANGE) and starts a new one at cycle 1", () => {
    const r = computeJourneys([order("o1", "2026-01-01", "mm"), order("o2", "2026-02-01", "mm"), order("o3", "2026-03-01", "cacao")], current({ externalProductId: "cacao" }), resolve, catalogue);
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0]).toMatchObject({ programId: "prog_mm", endReason: "PROGRAM_CHANGE", sequence: 1 });
    expect(r.segments[0].cycles).toHaveLength(2);
    expect(r.segments[0].endedAt).toEqual(d("2026-03-01"));
    expect(r.segments[1]).toMatchObject({ programId: "prog_cacao", sequence: 2, endedAt: null });
    expect(r.segments[1].cycles).toHaveLength(1);
    expect(r.currentIndex).toBe(1);
  });

  it("a swap with no new-product order yet creates a current journey at 0 cycles", () => {
    const r = computeJourneys([order("o1", "2026-01-01", "mm"), order("o2", "2026-02-01", "mm")], current({ externalProductId: "cacao" }), resolve, catalogue);
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0].endReason).toBe("PROGRAM_CHANGE");
    expect(r.segments[1].cycles).toHaveLength(0);
    expect(r.currentIndex).toBe(1);
  });

  it("unmapped current product → no current journey, mappingStatus UNMAPPED, history ended as UNMAPPED", () => {
    const r = computeJourneys([order("o1", "2026-01-01", "mm"), order("o2", "2026-02-01", "mm")], current({ externalProductId: "ube" }), resolve, catalogue);
    expect(r.mappingStatus).toBe("UNMAPPED");
    expect(r.currentIndex).toBeNull();
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].endReason).toBe("UNMAPPED");
    expect(r.currentProductId).toBeNull();
  });

  it("an unmapped order in the middle ends the journey and is counted as unresolved; a later mapped order starts a new journey", () => {
    const r = computeJourneys(
      [order("o1", "2026-01-01", "mm"), order("o2", "2026-02-01", "mm", "v-unmapped"), order("o3", "2026-03-01", "mm")],
      current(),
      resolve,
      catalogue,
    );
    expect(r.unresolvedOrders).toBe(1);
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0].endReason).toBe("UNMAPPED");
    expect(r.segments[1].cycles).toHaveLength(1);
    expect(r.currentIndex).toBe(1);
  });

  it("no orders + mapped product → one current journey with 0 cycles", () => {
    const r = computeJourneys([], current(), resolve, catalogue);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].cycles).toHaveLength(0);
    expect(r.segments[0].startedAt).toEqual(d("2026-01-01"));
    expect(r.currentIndex).toBe(0);
  });

  it("no orders + unmapped product → no journeys", () => {
    const r = computeJourneys([], current({ externalProductId: "ube" }), resolve, catalogue);
    expect(r.segments).toHaveLength(0);
    expect(r.mappingStatus).toBe("UNMAPPED");
  });

  it("cancelled subscription keeps its last journey, ended with CANCELLED at cancelledAt", () => {
    const r = computeJourneys([order("o1", "2026-01-01", "mm"), order("o2", "2026-02-01", "mm")], current({ status: "CANCELLED", cancelledAt: d("2026-02-15") }), resolve, catalogue);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]).toMatchObject({ endReason: "CANCELLED", endedAt: d("2026-02-15") });
    expect(r.segments[0].cycles).toHaveLength(2);
    expect(r.currentIndex).toBe(0);
  });

  it("is deterministic: same input twice → identical output", () => {
    const input = [order("o1", "2026-01-01", "mm"), order("o2", "2026-02-01", "cacao"), order("o3", "2026-03-01", "cacao")];
    const a = computeJourneys(input, current({ externalProductId: "cacao" }), resolve, catalogue);
    const b = computeJourneys(input, current({ externalProductId: "cacao" }), resolve, catalogue);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  // ── regression fixtures from the live Ancient Extracts validation (21 Aug 2026) ──
  it("AE 861649121: an active subscription with a queued charge but no successful order has successfulCycles = 0", () => {
    // only SUCCESSFUL orders ever become facts; a queued/scheduled charge never does
    const r = computeJourneys([], current({ externalCreatedAt: d("2026-08-09") }), resolve, catalogue);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].cycles).toHaveLength(0);
    expect(r.currentIndex).toBe(0);
  });

  it("AE 735805552: starter-kit product → main product inside the same programme continues the journey (5 + 2 = 7)", () => {
    const sk = (id: string, at: string) => order(id, at, "mm", "sk-default");
    const r = computeJourneys(
      [sk("o1", "2025-12-11"), sk("o2", "2026-01-08"), sk("o3", "2026-02-06"), sk("o4", "2026-04-05"), sk("o5", "2026-04-29"), order("o6", "2026-06-07", "mm"), order("o7", "2026-07-11", "mm")],
      current(),
      resolve,
      catalogue,
    );
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].cycles.map((c) => c.cycleNumber)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("AE 735782768: orders on an unmapped bundle before the mapped product are excluded; the mapped journey starts at 1 (7, not 9)", () => {
    const r = computeJourneys(
      [order("p1", "2025-12-11", "pair"), order("p2", "2026-01-08", "pair"), ...[2, 3, 4, 5, 6, 7, 8].map((m) => order(`r${m}`, `2026-0${m}-05`, "cacao"))],
      current({ externalProductId: "cacao" }),
      resolve,
      catalogue,
    );
    expect(r.unresolvedOrders).toBe(2);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].cycles).toHaveLength(7);
  });

  it("AE 849878775: two successful orders on the same day for different programmes → only the mapped one counts, the journey starts at 1", () => {
    const r = computeJourneys([order("lm1", "2026-07-16", "unmapped-lm"), order("lm2", "2026-08-13", "unmapped-lm"), order("mm1", "2026-08-13", "mm")], current(), resolve, catalogue);
    expect(r.unresolvedOrders).toBe(2);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].cycles).toEqual([expect.objectContaining({ cycleNumber: 1, externalOrderId: "mm1" })]);
    // Amendment 9: a programme entered AFTER other-product history starts at its first counted order,
    // not at subscription creation (2026-07-16 is Lion's Mane history)
    expect(r.segments[0].startedAt).toEqual(d("2026-08-13"));
  });

  it("startedAt inherits subscription creation only when the first order belongs to the programme", () => {
    const first = computeJourneys([order("o1", "2026-01-10", "mm")], current({ externalCreatedAt: d("2026-01-01") }), resolve, catalogue);
    expect(first.segments[0].startedAt).toEqual(d("2026-01-01"));
    const later = computeJourneys([order("u1", "2026-01-10", "unmapped"), order("o2", "2026-02-10", "mm")], current({ externalCreatedAt: d("2026-01-01") }), resolve, catalogue);
    expect(later.segments[0].startedAt).toEqual(d("2026-02-10"));
    expect(later.segments[0].cycles).toHaveLength(1);
  });

  it("duplicate order ids are not double counted by the caller contract (one fact per order)", () => {
    // computeJourneys trusts facts are unique per order; SubscriptionOrder's unique index guarantees it upstream.
    const r = computeJourneys([order("o1", "2026-01-01", "mm")], current(), resolve, catalogue);
    expect(r.segments[0].cycles).toHaveLength(1);
  });
});

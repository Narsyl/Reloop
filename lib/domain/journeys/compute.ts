/**
 * Pure journey computation — no I/O, fully unit-testable.
 *
 * Input: a subscription's successful order facts (oldest → newest), its current
 * product/variant/status, and a program resolver. Output: the journey segments
 * the database should contain, the current mapping status, and the cycle list
 * per segment.
 *
 * Rules (ARCHITECTURE.md §8, §9, §21 D7):
 *  - A cycle is one successful order for this subscription's line item. Checkout
 *    order = cycle 1. Orders are counted within the program journey they belong to.
 *  - Same program across orders → same journey, even if the variant changed.
 *  - Program change between orders → end journey (PROGRAM_CHANGE), start a new one at 0.
 *  - An order whose product/variant cannot be resolved to a program ends the
 *    current journey (UNMAPPED) and starts no journey; it is counted as unresolved.
 *  - After the last order, the subscription's CURRENT product decides the current
 *    journey: same program → continue; different program → a new journey at 0
 *    (swap detected from subscription state); unmapped → no current journey,
 *    mappingStatus UNMAPPED.
 *  - Cancelled/expired subscriptions keep their last journey (ended) for history.
 */
import type { JourneyEndReason, OrderKind, SubscriptionStatus } from "@prisma/client";

export type OrderFact = {
  externalOrderId: string;
  processedAt: Date;
  orderKind: OrderKind;
  externalProductId: string;
  externalVariantId: string;
};

export type CurrentState = {
  status: SubscriptionStatus;
  externalProductId: string;
  externalVariantId: string;
  externalCreatedAt: Date | null;
  cancelledAt: Date | null;
  /** "now" for deterministic tests */
  asOf: Date;
};

export type Resolved = { programId: string; productId: string; variantId: string | null };
export type ResolveFn = (externalProductId: string, externalVariantId: string | null) => Resolved | null;

export type ComputedCycle = { cycleNumber: number; externalOrderId: string; processedAt: Date; orderKind: OrderKind };

export type ComputedSegment = {
  sequence: number;
  programId: string;
  productId: string | null;
  variantId: string | null;
  externalProductId: string;
  externalVariantId: string;
  startedAt: Date;
  endedAt: Date | null;
  endReason: JourneyEndReason | null;
  cycles: ComputedCycle[];
};

export type JourneyComputation = {
  segments: ComputedSegment[];
  /** index into segments of the journey `Subscription.currentJourneyId` should point at, or null */
  currentIndex: number | null;
  mappingStatus: "MAPPED" | "UNMAPPED";
  unresolvedOrders: number;
  /** catalogue ids for the current product/variant even when unmapped */
  currentProductId: string | null;
  currentVariantId: string | null;
};

function sortOrders(orders: OrderFact[]): OrderFact[] {
  return [...orders].sort((a, b) => a.processedAt.getTime() - b.processedAt.getTime() || a.externalOrderId.localeCompare(b.externalOrderId, undefined, { numeric: true }));
}

export function computeJourneys(
  ordersIn: OrderFact[],
  current: CurrentState,
  resolve: ResolveFn,
  catalogue: (externalProductId: string, externalVariantId: string | null) => { productId: string | null; variantId: string | null },
): JourneyComputation {
  const orders = sortOrders(ordersIn);
  const segments: ComputedSegment[] = [];
  let open: ComputedSegment | null = null;
  let unresolvedOrders = 0;

  const close = (seg: ComputedSegment, endedAt: Date, reason: JourneyEndReason) => {
    seg.endedAt = endedAt;
    seg.endReason = reason;
  };

  for (const o of orders) {
    const r = resolve(o.externalProductId, o.externalVariantId);
    if (!r) {
      unresolvedOrders++;
      if (open) {
        close(open, o.processedAt, "UNMAPPED");
        open = null;
      }
      continue;
    }
    if (open && open.programId === r.programId) {
      open.cycles.push({ cycleNumber: open.cycles.length + 1, externalOrderId: o.externalOrderId, processedAt: o.processedAt, orderKind: o.orderKind });
      // variant may change within a program; track the latest
      open.externalVariantId = o.externalVariantId;
      open.variantId = r.variantId;
      continue;
    }
    if (open) close(open, o.processedAt, "PROGRAM_CHANGE");
    open = {
      sequence: segments.length + 1,
      programId: r.programId,
      productId: r.productId,
      variantId: r.variantId,
      externalProductId: o.externalProductId,
      externalVariantId: o.externalVariantId,
      startedAt: segments.length === 0 && current.externalCreatedAt && current.externalCreatedAt < o.processedAt ? current.externalCreatedAt : o.processedAt,
      endedAt: null,
      endReason: null,
      cycles: [{ cycleNumber: 1, externalOrderId: o.externalOrderId, processedAt: o.processedAt, orderKind: o.orderKind }],
    };
    segments.push(open);
  }

  // Current product decides the live journey.
  const cur = resolve(current.externalProductId, current.externalVariantId);
  const cat = catalogue(current.externalProductId, current.externalVariantId);
  let currentIndex: number | null = null;
  let mappingStatus: "MAPPED" | "UNMAPPED" = "UNMAPPED";

  if (cur) {
    mappingStatus = "MAPPED";
    if (open && open.programId === cur.programId) {
      open.externalVariantId = current.externalVariantId;
      open.variantId = cur.variantId;
      currentIndex = segments.indexOf(open);
    } else {
      const lastEnd = open ? (open.cycles.at(-1)?.processedAt ?? current.asOf) : (segments.at(-1)?.endedAt ?? current.asOf);
      if (open) close(open, lastEnd, "PROGRAM_CHANGE");
      const fresh: ComputedSegment = {
        sequence: segments.length + 1,
        programId: cur.programId,
        productId: cur.productId,
        variantId: cur.variantId,
        externalProductId: current.externalProductId,
        externalVariantId: current.externalVariantId,
        startedAt: segments.length === 0 ? (current.externalCreatedAt ?? current.asOf) : lastEnd,
        endedAt: null,
        endReason: null,
        cycles: [],
      };
      segments.push(fresh);
      open = fresh;
      currentIndex = segments.length - 1;
    }
  } else {
    if (open) {
      close(open, open.cycles.at(-1)?.processedAt ?? current.asOf, "UNMAPPED");
      open = null;
    }
    currentIndex = null;
  }

  // Lifecycle end for inactive subscriptions: the live journey is ended but remains "current" for history.
  if (current.status === "CANCELLED" || current.status === "EXPIRED") {
    const idx = currentIndex ?? segments.length - 1;
    if (idx >= 0) {
      const seg = segments[idx];
      if (!seg.endedAt) close(seg, current.cancelledAt ?? current.asOf, current.status === "CANCELLED" ? "CANCELLED" : "EXPIRED");
      currentIndex = idx;
    }
  }

  return {
    segments,
    currentIndex,
    mappingStatus,
    unresolvedOrders,
    currentProductId: cat.productId ?? cur?.productId ?? null,
    currentVariantId: cat.variantId ?? cur?.variantId ?? null,
  };
}

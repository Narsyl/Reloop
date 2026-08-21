import "server-only";
import type { Prisma } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import { buildProgramResolver, isResolved, type ProgramResolver } from "@/lib/domain/programs/resolve";
import { computeJourneys, type OrderFact } from "./compute";

/**
 * Recalculate journeys for one subscription from its SubscriptionOrder facts and
 * the organisation's current program mappings, reconciling existing journey rows
 * in place (by sequence) so journey ids stay stable for anything referencing them.
 *
 * Idempotent: running it N times yields the same rows. Never deletes a journey
 * that has actions — such journeys are ended with reason MANUAL and reported.
 */
export type RecalcResult = {
  subscriptionId: string;
  mappingStatus: "MAPPED" | "UNMAPPED";
  journeys: number;
  successfulCycles: number | null; // current journey's count
  unresolvedOrders: number;
  changed: boolean;
  orphanJourneysKept: number;
};

export async function recalculateJourneyForSubscription(
  ctx: { organizationId: string },
  subscriptionId: string,
  resolver?: ProgramResolver,
  asOf = new Date(),
): Promise<RecalcResult> {
  const db = dbFor(ctx);
  const sub = await db.subscription.findUnique({
    where: { id: subscriptionId },
    include: {
      orders: { where: { orderStatus: "success" }, orderBy: { processedAt: "asc" } },
      journeys: { orderBy: { sequence: "asc" }, include: { cycles: true, _count: { select: { actions: true } } } },
    },
  });
  if (!sub) throw new Error(`Subscription ${subscriptionId} not found in organisation`);
  const res = resolver ?? (await buildProgramResolver(ctx, sub.integrationId));

  const facts: OrderFact[] = sub.orders.map((o) => ({
    externalOrderId: o.externalOrderId,
    processedAt: o.processedAt,
    orderKind: o.orderKind,
    externalProductId: o.externalProductId,
    externalVariantId: o.externalVariantId,
  }));

  const computed = computeJourneys(
    facts,
    {
      status: sub.status,
      externalProductId: sub.externalProductId,
      externalVariantId: sub.externalVariantId,
      externalCreatedAt: sub.externalCreatedAt,
      cancelledAt: sub.cancelledAt,
      asOf,
    },
    (p, v) => {
      const r = res.resolve(p, v);
      return isResolved(r) ? { programId: r.programId, productId: r.productId, variantId: r.variantId } : null;
    },
    (p, v) => res.catalogue(p, v),
  );

  let changed = false;
  let orphanJourneysKept = 0;
  const existing = sub.journeys;

  // Interactive transaction on the org-scoped client: every write below is keyed
  // by ids loaded through the same scoped client, and creates carry organizationId.
  await db.$transaction(async (tx) => {
    const journeyIds: string[] = [];

    for (const [i, seg] of computed.segments.entries()) {
      const data = {
        programId: seg.programId,
        productId: seg.productId,
        variantId: seg.variantId,
        externalProductId: seg.externalProductId,
        externalVariantId: seg.externalVariantId,
        startedAt: seg.startedAt,
        endedAt: seg.endedAt,
        endReason: seg.endReason,
        successfulCycles: seg.cycles.length,
      } satisfies Prisma.SubscriptionJourneyUncheckedUpdateInput;
      const cur = existing[i];
      let journeyId: string;
      if (cur) {
        journeyId = cur.id;
        const same =
          cur.programId === data.programId &&
          cur.productId === data.productId &&
          cur.variantId === data.variantId &&
          cur.externalProductId === data.externalProductId &&
          cur.externalVariantId === data.externalVariantId &&
          cur.startedAt.getTime() === data.startedAt.getTime() &&
          (cur.endedAt?.getTime() ?? null) === (data.endedAt?.getTime() ?? null) &&
          cur.endReason === data.endReason &&
          cur.successfulCycles === data.successfulCycles;
        if (!same) {
          await tx.subscriptionJourney.update({ where: { id: cur.id }, data });
          changed = true;
        }
      } else {
        const created = await tx.subscriptionJourney.create({
          data: { ...data, organizationId: sub.organizationId, subscriptionId: sub.id, sequence: seg.sequence },
        });
        journeyId = created.id;
        changed = true;
      }
      journeyIds.push(journeyId);

      // cycles: remove rows not matching the desired (externalOrderId, cycleNumber) set, then upsert
      const desired = new Map(seg.cycles.map((c) => [c.externalOrderId, c]));
      const existingCycles = cur?.cycles ?? [];
      const stale = existingCycles.filter((c) => {
        const d = desired.get(c.externalOrderId);
        return !d || d.cycleNumber !== c.cycleNumber;
      });
      if (stale.length) {
        await tx.journeyCycle.deleteMany({ where: { id: { in: stale.map((c) => c.id) } } });
        changed = true;
      }
      const existingOk = new Set(existingCycles.filter((c) => !stale.includes(c)).map((c) => c.externalOrderId));
      for (const c of seg.cycles) {
        if (existingOk.has(c.externalOrderId)) continue;
        await tx.journeyCycle.create({
          data: {
            organizationId: sub.organizationId,
            journeyId,
            cycleNumber: c.cycleNumber,
            externalOrderId: c.externalOrderId,
            orderKind: c.orderKind,
            processedAt: c.processedAt,
            source: "BACKFILL",
          },
        });
        changed = true;
      }
    }

    // Surplus existing journeys (more rows than segments)
    for (const extra of existing.slice(computed.segments.length)) {
      if (extra._count.actions > 0) {
        orphanJourneysKept++;
        if (!extra.endedAt) {
          await tx.subscriptionJourney.update({ where: { id: extra.id }, data: { endedAt: asOf, endReason: "MANUAL" } });
          changed = true;
        }
      } else {
        await tx.subscriptionJourney.delete({ where: { id: extra.id } });
        changed = true;
      }
    }

    const currentJourneyId = computed.currentIndex === null ? null : journeyIds[computed.currentIndex] ?? null;
    if (
      sub.currentJourneyId !== currentJourneyId ||
      sub.mappingStatus !== computed.mappingStatus ||
      sub.productId !== computed.currentProductId ||
      sub.variantId !== computed.currentVariantId
    ) {
      await tx.subscription.update({
        where: { id: sub.id },
        data: {
          currentJourneyId,
          mappingStatus: computed.mappingStatus,
          productId: computed.currentProductId,
          variantId: computed.currentVariantId,
        },
      });
      changed = true;
    }
  });

  const currentSeg = computed.currentIndex === null ? null : computed.segments[computed.currentIndex];
  return {
    subscriptionId,
    mappingStatus: computed.mappingStatus,
    journeys: computed.segments.length,
    successfulCycles: currentSeg ? currentSeg.cycles.length : null,
    unresolvedOrders: computed.unresolvedOrders,
    changed,
    orphanJourneysKept,
  };
}

/** Recalculate a batch of subscriptions (shares one resolver). Returns aggregate counts. */
export async function recalculateJourneysForSubscriptions(ctx: { organizationId: string }, integrationId: string, subscriptionIds: string[], asOf = new Date()) {
  const resolver = await buildProgramResolver(ctx, integrationId);
  const agg = { processed: 0, mapped: 0, unmapped: 0, changed: 0, unresolvedOrders: 0, orphanJourneysKept: 0 };
  for (const id of subscriptionIds) {
    const r = await recalculateJourneyForSubscription(ctx, id, resolver, asOf);
    agg.processed++;
    if (r.mappingStatus === "MAPPED") agg.mapped++;
    else agg.unmapped++;
    if (r.changed) agg.changed++;
    agg.unresolvedOrders += r.unresolvedOrders;
    agg.orphanJourneysKept += r.orphanJourneysKept;
  }
  return agg;
}

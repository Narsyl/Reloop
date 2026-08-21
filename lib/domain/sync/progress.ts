import "server-only";
import type { SyncKind, SyncStage } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import { logActivity } from "@/lib/domain/activity/log";

/**
 * Persistent sync-run state. Inngest owns execution; these rows are the record
 * an operator can read: which stage, how far, what failed, what was counted.
 */
export type StageProgress = { cursor: string | null; pages: number; items: number; done: boolean; note?: string };
export type SyncProgress = Partial<Record<SyncStage, StageProgress>>;
export type SyncCounts = {
  products: number;
  variants: number;
  productsSkipped: number;
  customers: number;
  subscriptions: number;
  subscriptionsActive: number;
  subscriptionsInactive: number;
  orders: number;
  orderLines: number;
  orderLinesUnlinked: number;
  journeysProcessed: number;
  mapped: number;
  unmapped: number;
  unresolvedOrders: number;
  onetimes: number;
};

export const EMPTY_COUNTS: SyncCounts = {
  products: 0,
  variants: 0,
  productsSkipped: 0,
  customers: 0,
  subscriptions: 0,
  subscriptionsActive: 0,
  subscriptionsInactive: 0,
  orders: 0,
  orderLines: 0,
  orderLinesUnlinked: 0,
  journeysProcessed: 0,
  mapped: 0,
  unmapped: 0,
  unresolvedOrders: 0,
  onetimes: 0,
};

export async function createSyncRun(ctx: { organizationId: string; userId?: string | null }, integrationId: string, kind: SyncKind, updatedSince?: Date | null) {
  const db = dbFor(ctx);
  const running = await db.integrationSync.findFirst({ where: { integrationId, status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true } });
  if (running) throw new SyncAlreadyRunningError(running.id);
  return db.integrationSync.create({
    data: { organizationId: ctx.organizationId, integrationId, kind, status: "QUEUED", stage: "CONNECTING", triggeredById: ctx.userId ?? null, updatedSince: updatedSince ?? null, progressJson: {}, countsJson: EMPTY_COUNTS },
  });
}

export class SyncAlreadyRunningError extends Error {
  constructor(public readonly syncId: string) {
    super("A sync is already queued or running for this integration.");
    this.name = "SyncAlreadyRunningError";
  }
}

export async function getSyncRun(ctx: { organizationId: string }, syncId: string) {
  return dbFor(ctx).integrationSync.findUnique({ where: { id: syncId } });
}

export async function markSyncRunning(ctx: { organizationId: string }, syncId: string, inngestRunId?: string) {
  return dbFor(ctx).integrationSync.update({
    where: { id: syncId },
    data: { status: "RUNNING", startedAt: new Date(), lastHeartbeatAt: new Date(), inngestRunId: inngestRunId ?? undefined, error: null },
  });
}

export async function setSyncStage(ctx: { organizationId: string }, syncId: string, stage: SyncStage) {
  return dbFor(ctx).integrationSync.update({ where: { id: syncId }, data: { stage, lastHeartbeatAt: new Date() } });
}

/** Merge stage progress + counts (read-modify-write; single writer per run). */
export async function recordProgress(
  ctx: { organizationId: string },
  syncId: string,
  stage: SyncStage,
  progress: Partial<StageProgress>,
  countDelta: Partial<SyncCounts> = {},
) {
  const db = dbFor(ctx);
  const run = await db.integrationSync.findUniqueOrThrow({ where: { id: syncId }, select: { progressJson: true, countsJson: true } });
  const prev = (run.progressJson as SyncProgress | null) ?? {};
  const prevStage = prev[stage] ?? { cursor: null, pages: 0, items: 0, done: false };
  const counts = { ...EMPTY_COUNTS, ...((run.countsJson as Partial<SyncCounts> | null) ?? {}) };
  for (const [k, v] of Object.entries(countDelta)) counts[k as keyof SyncCounts] += v ?? 0;
  const next: SyncProgress = { ...prev, [stage]: { ...prevStage, ...progress } };
  await db.integrationSync.update({ where: { id: syncId }, data: { stage, progressJson: next, countsJson: counts, lastHeartbeatAt: new Date() } });
  return { progress: next, counts };
}

export async function completeSyncRun(ctx: { organizationId: string }, syncId: string) {
  const db = dbFor(ctx);
  const run = await db.integrationSync.update({ where: { id: syncId }, data: { status: "COMPLETED", stage: "COMPLETE", finishedAt: new Date(), lastHeartbeatAt: new Date() } });
  await db.integration.update({ where: { id: run.integrationId }, data: { lastSuccessfulSyncAt: new Date(), status: "CONNECTED", lastErrorAt: null, lastErrorMessage: null } });
  const counts = (run.countsJson as SyncCounts | null) ?? EMPTY_COUNTS;
  await logActivity(ctx, {
    actorType: "SYSTEM",
    eventType: "SYNC_COMPLETED",
    entityType: "INTEGRATION",
    entityId: run.integrationId,
    summary:
      run.kind === "RECALCULATE_JOURNEYS"
        ? `Journeys recalculated: ${counts.journeysProcessed} subscriptions (${counts.mapped} mapped, ${counts.unmapped} unmapped)`
        : `${run.kind === "INITIAL" ? "Initial import" : "Sync"} complete: ${counts.subscriptions} subscriptions (${counts.subscriptionsActive} active), ${counts.customers} customers, ${counts.products} products, ${counts.orders} orders; ${counts.mapped} mapped, ${counts.unmapped} unmapped. No changes were made to the subscription platform.`,
    metadata: counts as unknown as Record<string, number>,
  });
  return run;
}

export async function failSyncRun(ctx: { organizationId: string }, syncId: string, error: string, terminal: boolean) {
  const db = dbFor(ctx);
  const run = await db.integrationSync.update({ where: { id: syncId }, data: { status: "FAILED", finishedAt: new Date(), error: error.slice(0, 2000), lastHeartbeatAt: new Date() } });
  if (terminal) {
    await db.integration.update({ where: { id: run.integrationId }, data: { lastErrorAt: new Date(), lastErrorMessage: error.slice(0, 500) } });
  }
  await logActivity(ctx, {
    actorType: "SYSTEM",
    eventType: "SYNC_FAILED",
    entityType: "INTEGRATION",
    entityId: run.integrationId,
    summary: `Sync failed at stage ${run.stage}: ${error.slice(0, 200)}`,
  });
  return run;
}

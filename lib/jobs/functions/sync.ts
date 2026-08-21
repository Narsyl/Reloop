import { NonRetriableError } from "inngest";
import type { SyncStage } from "@prisma/client";
import { inngest, integrationSyncRequested } from "@/lib/jobs/inngest";
import { prisma } from "@/lib/db/prisma";
import { getRechargeConnectorForIntegration, IntegrationUnavailableError } from "@/lib/domain/integrations/connector";
import { isRechargeError } from "@/lib/integrations/recharge/errors";
import {
  completeSyncRun,
  failSyncRun,
  getSyncRun,
  markSyncRunning,
  recordProgress,
  setSyncStage,
  type SyncProgress,
} from "@/lib/domain/sync/progress";
import {
  importCustomersPage,
  importOrdersPage,
  importProductsPage,
  importSubscriptionsPage,
  recalculateJourneysBatch,
  relinkOrphanOrders,
} from "@/lib/domain/sync/stages";
import { logger } from "@/lib/logging/logger";

/**
 * INITIAL / INCREMENTAL sync — READ-ONLY against the provider.
 *
 * Structure: one Inngest step per page. Step results are memoised, so a retry
 * after a crash replays completed pages instantly and continues from the last
 * cursor; the cursor is ALSO persisted on IntegrationSync so the UI can show
 * progress and an operator can see exactly where a failed run stopped.
 *
 * Transient connector errors (429/5xx/network) throw → Inngest retries the step.
 * Terminal errors (auth, permission, schema) → NonRetriableError → run FAILED
 * with the reason recorded.
 */
const JOURNEY_BATCH = 200;
const MAX_PAGES_PER_STAGE = 5000; // 1.25M records at 250/page — safety valve, not a target

function isTerminal(e: unknown): boolean {
  if (e instanceof IntegrationUnavailableError) return true;
  if (isRechargeError(e)) return !e.retriable;
  return false;
}

export const runIntegrationSync = inngest.createFunction(
  {
    id: "integration-sync",
    name: "Integration sync (read-only import)",
    triggers: [integrationSyncRequested],
    concurrency: [{ key: "event.data.integrationId", limit: 1 }],
    retries: 4,
    onFailure: async ({ event, error }) => {
      const { syncId, organizationId } = event.data.event.data;
      await failSyncRun({ organizationId }, syncId, error.message, true).catch(() => undefined);
    },
  },
  async ({ event, step, runId }) => {
    const { syncId, integrationId, organizationId } = event.data;
    const ctx = { organizationId };
    const log = logger.child({ organizationId, integrationId, syncId, inngestRunId: runId });

    const run = await step.run("load-run", async () => {
      const r = await getSyncRun(ctx, syncId);
      if (!r) throw new NonRetriableError(`Sync run ${syncId} not found`);
      if (r.status === "COMPLETED" || r.status === "CANCELLED") return { skip: true as const, kind: r.kind, updatedSince: null as string | null, progress: {} as SyncProgress, timezone: "UTC" };
      const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } });
      await markSyncRunning(ctx, syncId, runId);
      return { skip: false as const, kind: r.kind, updatedSince: r.updatedSince?.toISOString() ?? null, progress: (r.progressJson as SyncProgress | null) ?? {}, timezone: org.timezone };
    });
    if (run.skip) return { skipped: true };
    const updatedSince = run.updatedSince ? new Date(run.updatedSince) : null;

    const wrap = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        if (isTerminal(e)) {
          const message = e instanceof Error ? e.message : String(e);
          await failSyncRun(ctx, syncId, message, true);
          throw new NonRetriableError(message);
        }
        log.warn("sync.transient_error", { label, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    };

    const connector = async () => (await getRechargeConnectorForIntegration(ctx, integrationId, { correlationId: `sync_${syncId.slice(-8)}` })).connector;

    // ── CONNECTING: verify credentials still work ──
    await step.run("connecting", () =>
      wrap("connecting", async () => {
        await setSyncStage(ctx, syncId, "CONNECTING");
        const c = await connector();
        const store = await c.getStore();
        await recordProgress(ctx, syncId, "CONNECTING", { done: true, note: `Connected to ${store.name}` });
        return store.name;
      }),
    );

    const stageLoop = async (
      stage: SyncStage,
      label: string,
      pageFn: (cursor: string | null) => Promise<{ nextCursor: string | null; items: number; delta: Record<string, number | undefined> }>,
    ) => {
      await step.run(`${label}:start`, () => setSyncStage(ctx, syncId, stage));
      const previous = run.progress[stage];
      let cursor: string | null = previous && !previous.done ? previous.cursor : null;
      let page = previous && !previous.done ? previous.pages : 0;
      for (;;) {
        page++;
        if (page > MAX_PAGES_PER_STAGE) throw new NonRetriableError(`${label}: exceeded ${MAX_PAGES_PER_STAGE} pages`);
        const res: { nextCursor: string | null; items: number } = await step.run(`${label}:page:${page}`, () =>
          wrap(`${label}:page:${page}`, async () => {
            const r = await pageFn(cursor);
            await recordProgress(ctx, syncId, stage, { cursor: r.nextCursor, pages: page, items: (previous?.items ?? 0) + r.items, done: r.nextCursor === null }, r.delta);
            return { nextCursor: r.nextCursor, items: r.items };
          }),
        );
        if (!res.nextCursor) break;
        cursor = res.nextCursor;
      }
    };

    if (run.kind !== "RECALCULATE_JOURNEYS") {
      await stageLoop("PRODUCTS", "products", async (cursor) => importProductsPage(ctx, await connector(), integrationId, cursor, updatedSince));
      await stageLoop("CUSTOMERS", "customers", async (cursor) => importCustomersPage(ctx, await connector(), integrationId, cursor, updatedSince));
      for (const status of ["active", "cancelled", "expired"] as const) {
        await stageLoop("SUBSCRIPTIONS", `subscriptions:${status}`, async (cursor) => importSubscriptionsPage({ ...ctx, timezone: run.timezone }, await connector(), integrationId, status, cursor, updatedSince));
      }
      await stageLoop("ORDERS", "orders", async (cursor) => importOrdersPage(ctx, await connector(), integrationId, cursor, updatedSince));
      await step.run("orders:relink", () => wrap("orders:relink", () => relinkOrphanOrders(ctx, integrationId)));
    }

    // ── JOURNEYS: recalculate in batches ──
    await step.run("journeys:start", () => setSyncStage(ctx, syncId, "JOURNEYS"));
    let offset = 0;
    for (let batch = 1; batch <= MAX_PAGES_PER_STAGE; batch++) {
      const r = await step.run(`journeys:batch:${batch}`, () =>
        wrap(`journeys:batch:${batch}`, async () => {
          const res = await recalculateJourneysBatch(ctx, integrationId, offset, JOURNEY_BATCH);
          await recordProgress(ctx, syncId, "JOURNEYS", { pages: batch, items: offset + res.processed, done: res.done }, { journeysProcessed: res.processed, mapped: res.mapped, unmapped: res.unmapped, unresolvedOrders: res.unresolvedOrders });
          return res;
        }),
      );
      offset += r.processed;
      if (r.done) break;
    }

    await step.run("complete", () => completeSyncRun(ctx, syncId));
    return { syncId, completed: true };
  },
);

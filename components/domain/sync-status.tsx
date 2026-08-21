"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { SyncKind, SyncStage, SyncStatus as SyncRunStatus } from "@prisma/client";
import { CheckCircle2, CircleDashed, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type SyncStatusData = {
  id: string;
  kind: SyncKind;
  status: SyncRunStatus;
  stage: SyncStage;
  error: string | null;
  progress: Partial<Record<SyncStage, { cursor: string | null; pages: number; items: number; done: boolean; note?: string }>>;
  counts: Record<string, number>;
  startedAt: string | null;
  finishedAt: string | null;
};

const STAGES: { key: SyncStage; label: string; countKey?: string }[] = [
  { key: "CONNECTING", label: "Connecting" },
  { key: "PRODUCTS", label: "Importing products", countKey: "products" },
  { key: "CUSTOMERS", label: "Importing customers", countKey: "customers" },
  { key: "SUBSCRIPTIONS", label: "Importing subscriptions", countKey: "subscriptions" },
  { key: "ORDERS", label: "Importing historical orders", countKey: "orders" },
  { key: "ONETIMES", label: "Counting one-times", countKey: "onetimes" },
  { key: "JOURNEYS", label: "Calculating journeys", countKey: "journeysProcessed" },
  { key: "COMPLETE", label: "Complete" },
];

const ORDER: SyncStage[] = STAGES.map((s) => s.key);

/**
 * Stage list for a sync run. While the run is live, polls by refreshing the
 * server component tree every few seconds (no client state to get stale).
 */
export function SyncStatus({ sync, compact = false }: { sync: SyncStatusData; compact?: boolean }) {
  const router = useRouter();
  const live = sync.status === "QUEUED" || sync.status === "RUNNING";
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [live, router]);

  const currentIdx = ORDER.indexOf(sync.stage);
  const stages = sync.kind === "RECALCULATE_JOURNEYS" ? STAGES.filter((s) => ["CONNECTING", "JOURNEYS", "COMPLETE"].includes(s.key)) : STAGES;

  return (
    <ol className={cn("space-y-1.5", compact && "text-xs")}>
      {stages.map((s) => {
        const idx = ORDER.indexOf(s.key);
        const p = sync.progress[s.key];
        let state: "done" | "active" | "pending" | "failed" = "pending";
        if (sync.status === "COMPLETED") state = "done";
        else if (sync.status === "FAILED" || sync.status === "CANCELLED") state = idx < currentIdx ? "done" : idx === currentIdx ? "failed" : "pending";
        else state = idx < currentIdx || p?.done ? "done" : idx === currentIdx ? "active" : "pending";
        if (s.key === "COMPLETE" && sync.status !== "COMPLETED") state = "pending";
        const count = s.countKey ? sync.counts[s.countKey] : undefined;
        return (
          <li key={s.key} className="flex items-center gap-2">
            {state === "done" && <CheckCircle2 className="size-4 text-status-success" />}
            {state === "active" && <Loader2 className="size-4 animate-spin text-status-info" />}
            {state === "failed" && <XCircle className="size-4 text-status-danger" />}
            {state === "pending" && <CircleDashed className="size-4 text-muted-foreground/60" />}
            <span className={cn("text-sm", state === "pending" && "text-muted-foreground", compact && "text-xs")}>{s.label}</span>
            {count !== undefined && count > 0 && <span className="tnum text-xs text-muted-foreground">{count.toLocaleString("en-GB")}</span>}
            {p && !p.done && state === "active" && p.pages > 0 && <span className="text-xs text-muted-foreground">· page {p.pages}</span>}
            {p?.note && state !== "pending" && <span className="text-xs text-muted-foreground">· {p.note}</span>}
          </li>
        );
      })}
      {sync.error && <li className="rounded-md bg-status-danger-bg px-3 py-2 text-xs text-status-danger">{sync.error}</li>}
    </ol>
  );
}

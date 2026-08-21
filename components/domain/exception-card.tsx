"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import type { ExceptionSeverity, ExceptionStatus } from "@prisma/client";
import { exceptionSeverity, exceptionStatus } from "@/lib/status";
import { formatDateTime, formatRelative } from "@/lib/format";
import { resolveException } from "@/lib/domain/exceptions/actions";
import { StatusBadge } from "@/components/status/status-badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type ExceptionCardData = {
  id: string;
  severity: ExceptionSeverity;
  status: ExceptionStatus;
  type: string;
  title: string;
  description: string;
  autoResolved: boolean;
  detectedAt: Date;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  subscription: { id: string; productTitleSnapshot: string; customerLabel: string } | null;
  action: { id: string; markerName: string; targetCycle: number; targetChargeDate: string | null } | null;
  rule: { id: string; name: string } | null;
  integration: { id: string; displayName: string } | null;
  metadata: Record<string, unknown> | null;
};

const stripe: Record<ExceptionSeverity, string> = {
  CRITICAL: "border-l-status-danger",
  WARNING: "border-l-status-warning",
  INFO: "border-l-status-info",
};

export function ExceptionCard({ item, timeZone, canResolve }: { item: ExceptionCardData; timeZone: string; canResolve: boolean }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();

  function close(outcome: "RESOLVED" | "IGNORED") {
    start(async () => {
      const res = await resolveException({ id: item.id, outcome, note });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(outcome === "RESOLVED" ? "Marked as resolved" : "Ignored");
      setOpen(false);
    });
  }

  return (
    <li className={cn("rounded-xl border border-border border-l-4 bg-card p-4", stripe[item.severity])}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={exceptionSeverity[item.severity]} />
            {item.status !== "OPEN" && <StatusBadge status={exceptionStatus[item.status]} />}
            {item.autoResolved && <span className="text-[11px] text-muted-foreground">Resolved automatically</span>}
            <h3 className="text-sm font-semibold">{item.title}</h3>
          </div>
          <p className="text-sm text-foreground/80">{item.description}</p>
          <dl className="flex flex-wrap gap-x-5 gap-y-1 pt-1 text-xs text-muted-foreground">
            {item.subscription && (
              <div>
                <dt className="inline">Subscription: </dt>
                <dd className="inline">
                  <Link href={`/subscriptions/${item.subscription.id}`} className="text-foreground hover:underline">
                    {item.subscription.customerLabel} · {item.subscription.productTitleSnapshot}
                  </Link>
                </dd>
              </div>
            )}
            {item.action && (
              <div>
                <dt className="inline">Action: </dt>
                <dd className="inline text-foreground">
                  {item.action.markerName} · cycle {item.action.targetCycle}
                  {item.action.targetChargeDate ? ` · ${item.action.targetChargeDate}` : ""}
                </dd>
              </div>
            )}
            {item.rule && (
              <div>
                <dt className="inline">Rule: </dt>
                <dd className="inline">
                  <Link href={`/rules/${item.rule.id}`} className="text-foreground hover:underline">{item.rule.name}</Link>
                </dd>
              </div>
            )}
            {item.integration && (
              <div>
                <dt className="inline">Integration: </dt>
                <dd className="inline text-foreground">{item.integration.displayName}</dd>
              </div>
            )}
            <div>
              <dt className="inline">Detected: </dt>
              <dd className="inline" title={formatDateTime(item.detectedAt, timeZone)}>{formatRelative(item.detectedAt)}</dd>
            </div>
            <div>
              <dt className="inline">Type: </dt>
              <dd className="inline font-mono">{item.type}</dd>
            </div>
          </dl>
          {item.resolutionNote && <p className="text-xs text-muted-foreground">Note: {item.resolutionNote}</p>}
        </div>
        {item.status === "OPEN" && canResolve && (
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
              {open ? "Close" : "Resolve"}
            </Button>
          </div>
        )}
      </div>
      {open && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <Textarea
            placeholder="What did you do? (optional, kept in the activity log)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => close("RESOLVED")} disabled={pending}>
              Mark resolved
            </Button>
            <Button size="sm" variant="ghost" onClick={() => close("IGNORED")} disabled={pending}>
              Ignore
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

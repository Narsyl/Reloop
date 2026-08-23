"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ImpactBucket, ImpactRow, ImpactSummary } from "@/lib/domain/rules/impact";
import { INELIGIBILITY_LABEL } from "@/lib/domain/eligibility/evaluate";
import { DISQUALIFICATION_LABEL } from "@/lib/domain/eligibility/qualify";
import { formatDateOnly, formatNumber, ordinal } from "@/lib/format";
import { cn } from "@/lib/utils";

const BUCKET_LABEL: Record<ImpactBucket, { label: string; tone: "success" | "info" | "warning" | "neutral" | "danger" }> = {
  WOULD_QUALIFY_NOW: { label: "Would qualify now", tone: "success" },
  FUTURE_ONLY: { label: "Future only (not yet at the previous delivery)", tone: "info" },
  ALREADY_PAST: { label: "Already past this delivery", tone: "neutral" },
  NO_UPCOMING_CHARGE: { label: "No upcoming charge", tone: "warning" },
  CANCELLED_OR_INACTIVE: { label: "Cancelled / inactive", tone: "neutral" },
  JOURNEY_ENDED: { label: "Journey ended", tone: "neutral" },
  UNMAPPED_OR_BROKEN: { label: "Unmapped / broken mapping", tone: "danger" },
  OTHER_INELIGIBLE: { label: "Other", tone: "neutral" },
};

const toneText: Record<string, string> = { success: "text-status-success", info: "text-status-info", warning: "text-status-warning", danger: "text-status-danger", neutral: "text-muted-foreground" };

function rowExplanation(r: ImpactRow, scope: "PER_SUBSCRIPTION" | "CUSTOMER_PROGRAM"): string {
  if (!r.eligibility.eligible) return r.eligibility.reasons.map((x) => INELIGIBILITY_LABEL[x]).join("; ");
  const q = scope === "PER_SUBSCRIPTION" ? r.perSubscription : r.customerProgram;
  if (q.qualifies) return "Qualifies — would be planned for the next shipment";
  return q.reason ? DISQUALIFICATION_LABEL[q.reason] : "—";
}

export function ImpactPanel({ impact, markerName }: { impact: ImpactSummary; markerName?: string }) {
  const [scope, setScope] = useState<"PER_SUBSCRIPTION" | "CUSTOMER_PROGRAM">("PER_SUBSCRIPTION");
  const [open, setOpen] = useState<ImpactBucket | "DIFF" | null>(null);
  const b = impact.buckets;
  const rowsFor = (bucket: ImpactBucket) => impact.rows.filter((r) => r.bucket === bucket);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="text-sm">
          <span className="font-semibold">{impact.programName}</span> · delivery {impact.cycleNumber}
          {markerName ? <span className="text-muted-foreground"> → {markerName}</span> : null}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {formatNumber(impact.totalSubscriptions)} subscriptions in this programme · {formatNumber(impact.active)} active · {formatNumber(impact.atPreviousCycle)} currently at delivery {impact.cycleNumber - 1}
        </div>
        <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
          {(Object.keys(BUCKET_LABEL) as ImpactBucket[]).filter((k) => b[k] > 0).map((k) => (
            <li key={k}>
              <button type="button" onClick={() => setOpen(open === k ? null : k)} className={cn("flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-sm hover:bg-muted", open === k && "bg-muted")}>
                <span className={toneText[BUCKET_LABEL[k].tone]}>{BUCKET_LABEL[k].label}</span>
                <span className="tnum font-medium">{b[k]}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-2 text-sm font-semibold">Who counts towards this milestone?</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <button type="button" onClick={() => setScope("PER_SUBSCRIPTION")} className={cn("rounded-lg border p-3 text-left", scope === "PER_SUBSCRIPTION" ? "border-foreground/40 bg-surface" : "border-border hover:bg-muted/50")}>
            <div className="text-sm font-medium">Per subscription</div>
            <div className="mt-1 text-2xl font-semibold tnum">{impact.perSubscription.qualifyNow}</div>
            <div className="text-xs text-muted-foreground">would qualify now · {impact.perSubscription.futureOnly} future only · {impact.perSubscription.alreadyPast} already past</div>
            <p className="mt-2 text-xs text-muted-foreground">Each subscription restarts milestone eligibility — a returning customer&apos;s new subscription can qualify again.</p>
          </button>
          <button type="button" onClick={() => setScope("CUSTOMER_PROGRAM")} className={cn("rounded-lg border p-3 text-left", scope === "CUSTOMER_PROGRAM" ? "border-foreground/40 bg-surface" : "border-border hover:bg-muted/50")}>
            <div className="text-sm font-medium">Customer programme</div>
            <div className="mt-1 text-2xl font-semibold tnum">{impact.customerProgram.qualifyNow}</div>
            <div className="text-xs text-muted-foreground">
              would qualify now · {impact.customerProgram.futureOnly} future only · {impact.customerProgram.alreadyPast} already past · {impact.customerProgram.alreadyReachedViaOtherSubscription} already reached via an earlier subscription
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Lifetime deliveries of the same customer in this programme count, across cancelled and new subscriptions.</p>
          </button>
        </div>
        {impact.scopeDifferences.length > 0 && (
          <div className="mt-3">
            <button type="button" onClick={() => setOpen(open === "DIFF" ? null : "DIFF")} className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
              <ChevronDown className={cn("size-3.5 transition-transform", open === "DIFF" && "rotate-180")} />
              {impact.scopeDifferences.length} subscription{impact.scopeDifferences.length === 1 ? "" : "s"} where the two scopes disagree
            </button>
          </div>
        )}
        {impact.scopeDifferences.length === 0 && <p className="mt-3 text-xs text-muted-foreground">Both scopes give the same result for every subscription in this programme today.</p>}
      </div>

      {open && (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Subscription</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Cycle</th>
                <th className="px-3 py-2 text-right font-medium">Lifetime</th>
                <th className="px-3 py-2 font-medium">Next charge</th>
                <th className="px-3 py-2 font-medium">Per subscription</th>
                <th className="px-3 py-2 font-medium">Customer programme</th>
              </tr>
            </thead>
            <tbody>
              {(open === "DIFF" ? impact.scopeDifferences : rowsFor(open)).map((r) => (
                <tr key={r.subscriptionId} className="border-b border-border last:border-0">
                  <td className="px-3 py-2">
                    <Link href={`/subscriptions/${r.subscriptionId}`} className="font-medium hover:underline">{r.customerName}</Link>
                    {r.otherJourneysInProgram > 0 && <span className="ml-1 text-[11px] text-muted-foreground">· {r.otherJourneysInProgram} other journey{r.otherJourneysInProgram === 1 ? "" : "s"} in programme</span>}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.externalSubscriptionId}</td>
                  <td className="px-3 py-2 text-xs">{r.status}</td>
                  <td className="tnum px-3 py-2 text-right">{r.successfulCycles ?? "—"}</td>
                  <td className="tnum px-3 py-2 text-right">{r.lifetimeDeliveries}</td>
                  <td className="tnum px-3 py-2 text-xs">{formatDateOnly(r.nextChargeDate)}</td>
                  <td className={cn("px-3 py-2 text-xs", r.perSubscription.qualifies ? "text-status-success" : "text-muted-foreground")}>{rowExplanation(r, "PER_SUBSCRIPTION")}</td>
                  <td className={cn("px-3 py-2 text-xs", r.customerProgram.qualifies ? "text-status-success" : "text-muted-foreground")}>{rowExplanation(r, "CUSTOMER_PROGRAM")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Preview only — nothing is planned or written. “Qualifies now” means the subscription has completed delivery {impact.cycleNumber - 1} and its {ordinal(impact.cycleNumber)} delivery is the next upcoming shipment.
      </p>
    </div>
  );
}

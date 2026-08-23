import Link from "next/link";
import { Suspense } from "react";
import type { ActionStatus } from "@prisma/client";
import { CalendarClock } from "lucide-react";
import { hasRole, requireOrg } from "@/lib/auth/tenancy";
import { listIntegrationsForAutomation, listMarkersForFilter, listPlannerRuns, listUpcomingActions } from "@/lib/domain/queries/upcoming";
import { listProgramsForFilter } from "@/lib/domain/queries/subscriptions";
import { actionStatus, automationMode, dryRunState, eligibilityScopeLabel } from "@/lib/status";
import { customerName, formatDateOnly, formatDateTime, formatRelative, pluralize } from "@/lib/format";
import { PageHeader, SectionHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/data/empty-state";
import { ClearFilters, FilterBar, SelectFilter } from "@/components/data/filter-bar";
import { StatusBadge } from "@/components/status/status-badge";
import { RunPlannerButton } from "@/components/domain/automation-panel";

export const metadata = { title: "Upcoming" };

export default async function UpcomingPage({ searchParams }: PageProps<"/upcoming">) {
  const ctx = await requireOrg();
  const sp = await searchParams;
  const status = (typeof sp.status === "string" ? sp.status : "LIVE") as ActionStatus | "ALL" | "LIVE";
  const programId = typeof sp.program === "string" ? sp.program : undefined;
  const markerId = typeof sp.marker === "string" ? sp.marker : undefined;
  const integrationId = typeof sp.integration === "string" ? sp.integration : undefined;
  const [data, programs, markers, integrations, runs] = await Promise.all([
    listUpcomingActions(ctx, { status, programId, markerId, integrationId }),
    listProgramsForFilter(ctx),
    listMarkersForFilter(ctx),
    listIntegrationsForAutomation(ctx),
    listPlannerRuns(ctx, { take: 5 }),
  ]);
  const canManage = hasRole(ctx, "ADMIN");
  const now = new Date();

  return (
    <>
      <PageHeader
        title="Upcoming"
        description="Real planned actions: what the engine would add to which shipment. In dry run, each action is validated against fresh data and previewed — nothing is written to the subscription platform."
        meta={data.rows.length > 0 ? <span className="text-xs text-muted-foreground">{pluralize(data.rows.length, "action")}</span> : null}
      />

      <section className="mb-6 grid gap-3 lg:grid-cols-2">
        {integrations.map((i) => {
          const planned = i.counts.PLANNED ?? 0;
          const lr = i.lastPlannerRun;
          const c = (lr?.countsJson ?? {}) as Record<string, number | string | null>;
          return (
            <div key={i.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Link href={`/settings/integrations/${i.id}`} className="text-sm font-semibold hover:underline">{i.displayName}</Link>
                  <StatusBadge status={automationMode[i.automationMode]} />
                </div>
                {canManage && i.status === "CONNECTED" ? <RunPlannerButton integrationId={i.id} size="xs" disabled={i.automationMode === "OFF"} /> : null}
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                <span className="tnum font-medium text-foreground">{planned}</span> planned{i.counts.CANCELLED ? ` · ${i.counts.CANCELLED} cancelled` : ""}{i.counts.SUPERSEDED ? ` · ${i.counts.SUPERSEDED} superseded` : ""}
                {lr ? (
                  <>
                    {" · "}last planner run {formatRelative(lr.startedAt, now)} ({lr.trigger.toLowerCase()}) —{" "}
                    {c.skippedReason ? <span>skipped: {String(c.skippedReason)}</span> : <span className="tnum">{c.planned ?? 0} planned · {c.replanned ?? 0} replanned · {c.confirmed ?? 0} confirmed · {c.cancelled ?? 0} cancelled</span>}
                  </>
                ) : " · planner has not run yet"}
              </div>
              {i.automationMode === "OFF" ? <p className="mt-1 text-xs text-muted-foreground">Automation is off — switch this integration to dry run on its settings page to start planning.</p> : null}
            </div>
          );
        })}
      </section>

      <Suspense>
        <FilterBar>
          <SelectFilter
            name="status"
            label="Status"
            allLabel="Live (planned · attached · failed)"
            options={[
              { value: "PLANNED", label: "Planned" },
              { value: "ATTACHED", label: "Attached" },
              { value: "FULFILLED", label: "Fulfilled" },
              { value: "FAILED", label: "Failed" },
              { value: "CANCELLED", label: "Cancelled" },
              { value: "SUPERSEDED", label: "Superseded" },
              { value: "ALL", label: "Everything" },
            ]}
          />
          <SelectFilter name="program" label="Programme" options={programs.map((p) => ({ value: p.id, label: p.name }))} />
          <SelectFilter name="marker" label="Marker" options={markers.map((m) => ({ value: m.id, label: m.name }))} />
          {integrations.length > 1 ? <SelectFilter name="integration" label="Store" options={integrations.map((i) => ({ value: i.id, label: i.displayName }))} /> : null}
          <ClearFilters />
        </FilterBar>
      </Suspense>

      {data.rows.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="Nothing planned"
          description="When a subscription has completed the delivery before a Ready rule's target cycle and has an upcoming charge, the planner creates the action for its next shipment and it shows up here."
        />
      ) : (
        <div className="space-y-6">
          {data.groups.map(([date, rows]) => (
            <section key={date} className="space-y-2">
              <h2 className="tnum sticky top-14 z-10 -mx-1 bg-background/95 px-1 py-1 text-sm font-semibold backdrop-blur">
                {date === "unscheduled" ? "Unscheduled" : <>Target charge {formatDateOnly(date)}</>}
                <span className="ml-2 text-xs font-normal text-muted-foreground">{pluralize(rows.length, "action")}</span>
              </h2>
              <div className="overflow-x-auto rounded-xl border border-border bg-card">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="px-3 py-2 font-medium">Customer</th>
                      <th className="px-3 py-2 font-medium">Programme</th>
                      <th className="px-3 py-2 text-right font-medium">Target delivery</th>
                      <th className="px-3 py-2 font-medium">Marker</th>
                      <th className="px-3 py-2 font-medium">Planned execution</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Eligibility / risk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((a) => {
                      const state = dryRunState(a, now);
                      return (
                        <tr key={a.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                          <td className="px-3 py-2">
                            <Link href={`/upcoming/${a.id}`} className="block font-medium hover:underline">{customerName(a.subscription.customer)}</Link>
                            <span className="block text-xs text-muted-foreground">{a.subscription.productTitleSnapshot} · <span className="font-mono">{a.subscription.externalSubscriptionId}</span></span>
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">{a.journey.program.name}<span className="block text-[11px]">{a.milestone ? `${a.milestone.schedule.name} · delivery ${a.milestone.cycleNumber} → ${a.milestone.rewardItem.name} · ${eligibilityScopeLabel[a.milestone.eligibilityScope].label}` : a.rule ? `legacy rule: ${a.rule.name}` : "—"}</span></td>
                          <td className="tnum px-3 py-2 text-right">{a.targetCycle}</td>
                          <td className="px-3 py-2">{a.fulfillmentMarker.name}{a.fulfillmentMarker.placeholder ? <span className="ml-1 text-[11px] text-status-warning">placeholder</span> : null}<span className="block font-mono text-[11px] text-muted-foreground">{a.fulfillmentMarker.externalVariantId}</span></td>
                          <td className="tnum px-3 py-2 text-xs">{a.executeAfter ? formatDateTime(a.executeAfter, ctx.timezone) : "—"}{a.replanCount > 0 ? <span className="block text-[11px] text-muted-foreground">replanned ×{a.replanCount}</span> : null}</td>
                          <td className="px-3 py-2"><StatusBadge status={actionStatus[a.status]} />{a.dryRun ? <span className="ml-1 text-[11px] text-muted-foreground">dry run</span> : null}</td>
                          <td className="px-3 py-2"><StatusBadge status={state} />{a.lastDryRunAt ? <span className="block text-[11px] text-muted-foreground">checked {formatRelative(a.lastDryRunAt, now)}</span> : null}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}

      {runs.length > 0 ? (
        <section className="mt-8 space-y-2">
          <SectionHeader title="Planner runs" description="Each run re-evaluates the whole integration: Ready rules × programme population × eligibility scope. Idempotent — re-running never duplicates an action." />
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground"><tr className="border-b border-border"><th className="px-3 py-2 font-medium">When</th><th className="px-3 py-2 font-medium">Store</th><th className="px-3 py-2 font-medium">Trigger</th><th className="px-3 py-2 font-medium">Mode</th><th className="px-3 py-2 font-medium">Result</th></tr></thead>
              <tbody>
                {runs.map((r) => {
                  const c = (r.countsJson ?? {}) as Record<string, number | string | null>;
                  return (
                    <tr key={r.id} className="border-b border-border last:border-0">
                      <td className="tnum px-3 py-2 text-xs">{formatDateTime(r.startedAt, ctx.timezone)}</td>
                      <td className="px-3 py-2 text-xs">{r.integration.displayName}</td>
                      <td className="px-3 py-2 text-xs">{r.trigger.toLowerCase()}</td>
                      <td className="px-3 py-2 text-xs">{r.automationMode}</td>
                      <td className="px-3 py-2 text-xs">{r.status !== "COMPLETED" ? `${r.status}${r.error ? ` — ${r.error.slice(0, 80)}` : ""}` : c.skippedReason ? `skipped: ${String(c.skippedReason)}` : <span className="tnum">{c.subscriptionsEvaluated ?? 0} evaluated · {c.planned ?? 0} planned · {c.replanned ?? 0} replanned · {c.confirmed ?? 0} confirmed · {c.cancelled ?? 0} cancelled · {c.superseded ?? 0} superseded{Number(c.milestonesSkipped) > 0 ? ` · ${c.milestonesSkipped} milestone(s) not plannable` : ""}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}

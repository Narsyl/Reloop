import Link from "next/link";
import { Suspense } from "react";
import type { ActionStatus } from "@prisma/client";
import { CalendarClock } from "lucide-react";
import { requireOrg } from "@/lib/auth/tenancy";
import { listMarkersForFilter, listUpcomingActions } from "@/lib/domain/queries/upcoming";
import { listProgramsForFilter } from "@/lib/domain/queries/subscriptions";
import { actionStatus } from "@/lib/status";
import { customerName, formatDateOnly, pluralize } from "@/lib/format";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/data/empty-state";
import { ClearFilters, FilterBar, SelectFilter } from "@/components/data/filter-bar";
import { StatusBadge } from "@/components/status/status-badge";

export const metadata = { title: "Upcoming" };

export default async function UpcomingPage({ searchParams }: PageProps<"/upcoming">) {
  const ctx = await requireOrg();
  const sp = await searchParams;
  const status = (typeof sp.status === "string" ? sp.status : "LIVE") as ActionStatus | "ALL" | "LIVE";
  const programId = typeof sp.program === "string" ? sp.program : undefined;
  const markerId = typeof sp.marker === "string" ? sp.marker : undefined;
  const [data, programs, markers] = await Promise.all([
    listUpcomingActions(ctx, { status, programId, markerId }),
    listProgramsForFilter(ctx),
    listMarkersForFilter(ctx),
  ]);

  return (
    <>
      <PageHeader
        title="Upcoming"
        description="The operational forecast: what the system expects to add to which shipments, grouped by charge date. Planned markers are attached 72 hours before the charge by default."
        meta={data.rows.length > 0 ? <span className="text-xs text-muted-foreground">{pluralize(data.rows.length, "action")}</span> : null}
      />
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
              { value: "ALL", label: "Everything" },
            ]}
          />
          <SelectFilter name="program" label="Program" options={programs.map((p) => ({ value: p.id, label: p.name }))} />
          <SelectFilter name="marker" label="Marker" options={markers.map((m) => ({ value: m.id, label: m.name }))} />
          <ClearFilters />
        </FilterBar>
      </Suspense>

      {data.rows.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="Nothing scheduled"
          description="When a subscription completes the delivery before a rule's target cycle, the next shipment's marker is planned and shows up here."
        />
      ) : (
        <div className="space-y-6">
          {data.groups.map(([date, rows]) => (
            <section key={date} className="space-y-2">
              <h2 className="tnum sticky top-14 z-10 -mx-1 bg-background/95 px-1 py-1 text-sm font-semibold backdrop-blur">
                {date === "unscheduled" ? "Unscheduled" : formatDateOnly(date)}
                <span className="ml-2 text-xs font-normal text-muted-foreground">{pluralize(rows.length, "action")}</span>
              </h2>
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                {rows.map((a) => (
                  <li key={a.id} className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto_minmax(0,1fr)_auto]">
                    <div className="min-w-0">
                      <Link href={`/subscriptions/${a.subscriptionId}`} className="block truncate text-sm font-medium hover:underline">
                        {customerName(a.subscription.customer)}
                      </Link>
                      <div className="truncate text-xs text-muted-foreground">{a.subscription.productTitleSnapshot}</div>
                    </div>
                    <div className="hidden min-w-0 text-sm text-muted-foreground sm:block">{a.journey.program.name}</div>
                    <div className="tnum hidden text-sm sm:block">
                      <span className="text-muted-foreground">Next cycle</span> {a.targetCycle}
                    </div>
                    <div className="hidden min-w-0 truncate text-sm sm:block">→ {a.fulfillmentMarker.name}</div>
                    <StatusBadge status={actionStatus[a.status]} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

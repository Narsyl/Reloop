import { Suspense } from "react";
import type { ExceptionSeverity, ExceptionStatus } from "@prisma/client";
import { ShieldCheck } from "lucide-react";
import { hasRole, requireOrg } from "@/lib/auth/tenancy";
import { listExceptions } from "@/lib/domain/queries/exceptions";
import { customerName } from "@/lib/format";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/data/empty-state";
import { ClearFilters, FilterBar, SelectFilter } from "@/components/data/filter-bar";
import { ExceptionCard, type ExceptionCardData } from "@/components/domain/exception-card";

export const metadata = { title: "Exceptions" };

export default async function ExceptionsPage({ searchParams }: PageProps<"/exceptions">) {
  const ctx = await requireOrg();
  const sp = await searchParams;
  const status = (typeof sp.status === "string" ? sp.status : "OPEN") as ExceptionStatus | "ALL";
  const severity = (typeof sp.severity === "string" ? sp.severity : "ALL") as ExceptionSeverity | "ALL";
  const data = await listExceptions(ctx, { status, severity });
  const openCount = data.counts.filter((c) => c.status === "OPEN").reduce((n, c) => n + c._count._all, 0);
  const criticalOpen = data.counts.filter((c) => c.status === "OPEN" && c.severity === "CRITICAL").reduce((n, c) => n + c._count._all, 0);

  const items: ExceptionCardData[] = data.rows.map((e) => ({
    id: e.id,
    severity: e.severity,
    status: e.status,
    type: e.type,
    title: e.title,
    description: e.description,
    autoResolved: e.autoResolved,
    detectedAt: e.detectedAt,
    resolvedAt: e.resolvedAt,
    resolutionNote: e.resolutionNote,
    subscription: e.subscription
      ? { id: e.subscription.id, productTitleSnapshot: e.subscription.productTitleSnapshot, customerLabel: customerName(e.subscription.customer) }
      : null,
    action: e.action ? { id: e.action.id, markerName: e.action.fulfillmentMarker.name, targetCycle: e.action.targetCycle, targetChargeDate: e.action.targetChargeDate } : null,
    rule: e.rule,
    integration: e.integration,
    metadata: (e.metadataJson as Record<string, unknown> | null) ?? null,
  }));

  const needsAction = items.filter((i) => i.status === "OPEN" && !i.autoResolved);
  const informational = items.filter((i) => !(i.status === "OPEN" && !i.autoResolved));

  return (
    <>
      <PageHeader
        title="Exceptions"
        description="The operations inbox. When the platform is not confident it stops and tells you here rather than guessing."
        meta={
          openCount > 0 ? (
            <span className="text-xs text-muted-foreground">
              {openCount} open{criticalOpen > 0 ? ` · ${criticalOpen} critical` : ""}
            </span>
          ) : null
        }
      />
      <Suspense>
        <FilterBar>
          <SelectFilter
            name="status"
            label="Status"
            allLabel="All"
            options={[
              { value: "OPEN", label: "Open" },
              { value: "RESOLVED", label: "Resolved" },
              { value: "IGNORED", label: "Ignored" },
            ]}
          />
          <SelectFilter
            name="severity"
            label="Severity"
            options={[
              { value: "CRITICAL", label: "Critical" },
              { value: "WARNING", label: "Warning" },
              { value: "INFO", label: "Info" },
            ]}
          />
          <ClearFilters />
        </FilterBar>
      </Suspense>

      {items.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title={status === "OPEN" ? "Nothing needs your attention" : "No exceptions match"}
          description={status === "OPEN" ? "Open exceptions will appear here with what happened, who is affected and what to do." : "Try another status or severity."}
        />
      ) : (
        <div className="space-y-8">
          {needsAction.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold">Needs action</h2>
              <ul className="space-y-3">
                {needsAction.map((item) => (
                  <ExceptionCard key={item.id} item={item} timeZone={ctx.timezone} canResolve={hasRole(ctx, "OPERATOR")} />
                ))}
              </ul>
            </section>
          )}
          {informational.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-muted-foreground">{needsAction.length > 0 ? "Resolved automatically or closed" : "Closed"}</h2>
              <ul className="space-y-3">
                {informational.map((item) => (
                  <ExceptionCard key={item.id} item={item} timeZone={ctx.timezone} canResolve={false} />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </>
  );
}

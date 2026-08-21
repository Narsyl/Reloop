import Link from "next/link";
import { ArrowRight, Plug } from "lucide-react";
import { requireOrg } from "@/lib/auth/tenancy";
import { getOverview } from "@/lib/domain/queries/overview";
import { customerName, formatDateOnly, formatNumber } from "@/lib/format";
import { actionStatus, exceptionSeverity } from "@/lib/status";
import { PageHeader, SectionHeader } from "@/components/layout/page-header";
import { Metric, MetricGrid } from "@/components/data/metric";
import { EmptyState } from "@/components/data/empty-state";
import { StatusBadge } from "@/components/status/status-badge";
import { Timeline } from "@/components/timeline/timeline";
import { ActivityItem } from "@/components/timeline/activity-item";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Overview" };

export default async function OverviewPage() {
  const ctx = await requireOrg();
  const data = await getOverview(ctx);

  if (!data.hasIntegration) {
    return (
      <>
        <PageHeader title="Overview" description="Is your subscription automation healthy? Connect a platform to find out." />
        <EmptyState
          icon={Plug}
          title="Connect your first subscription platform"
          description="Connect Recharge to import subscriptions, calculate delivery cycles and create your first fulfilment rule. The import is read-only — nothing is written until you activate a rule."
          action={
            <Button render={<Link href="/settings/integrations" />}>
              Connect Recharge <ArrowRight data-icon="inline-end" />
            </Button>
          }
        />
      </>
    );
  }

  const { metrics } = data;
  return (
    <>
      <PageHeader title="Overview" description={`What the automation has done and is about to do for ${ctx.organizationName}.`} />

      <MetricGrid>
        <Metric label="Active subscriptions" value={formatNumber(metrics.activeSubscriptions)} href="/subscriptions?status=ACTIVE" />
        <Metric label="Actions in the next 7 days" value={formatNumber(metrics.actionsNext7)} hint="Planned or attached markers" href="/upcoming" />
        <Metric label="Successful actions · 30 days" value={formatNumber(metrics.succeeded30)} hint="Markers attached or fulfilled" href="/upcoming?status=ALL" />
        <Metric
          label="Open exceptions"
          value={formatNumber(metrics.openExceptions)}
          tone={metrics.openExceptions > 0 ? "danger" : "default"}
          hint={metrics.openExceptions > 0 ? "Needs attention" : "Nothing needs you"}
          href="/exceptions"
        />
      </MetricGrid>

      {data.exceptions.length > 0 && (
        <section className="space-y-3">
          <SectionHeader
            title="Exceptions requiring attention"
            actions={
              <Link href="/exceptions" className="text-xs font-medium text-primary hover:underline">
                View all
              </Link>
            }
          />
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {data.exceptions.map((e) => (
              <li key={e.id} className="flex items-start gap-3 px-4 py-3">
                <StatusBadge status={exceptionSeverity[e.severity]} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{e.title}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {e.subscription ? `${customerName(e.subscription.customer)} · ${e.subscription.productTitleSnapshot} · ` : ""}
                    {e.description}
                  </div>
                </div>
                <Link href="/exceptions" className="shrink-0 text-xs font-medium text-primary hover:underline">
                  Review
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        <SectionHeader
          title="Upcoming actions"
          description="What the system expects to do next, in charge-date order."
          actions={
            <Link href="/upcoming" className="text-xs font-medium text-primary hover:underline">
              Open forecast
            </Link>
          }
        />
        {data.upcoming.length === 0 ? (
          <EmptyState compact title="Nothing scheduled yet" description="Planned markers will appear here as subscriptions approach a rule's delivery cycle." />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Program</TableHead>
                  <TableHead className="text-right">Cycle</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Charge date</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.upcoming.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <Link href={`/subscriptions/${a.subscriptionId}`} className="font-medium hover:underline">
                        {customerName(a.subscription.customer)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{a.journey.program.name}</TableCell>
                    <TableCell className="tnum text-right">{a.targetCycle}</TableCell>
                    <TableCell>→ {a.fulfillmentMarker.name}</TableCell>
                    <TableCell className="tnum">{formatDateOnly(a.targetChargeDate)}</TableCell>
                    <TableCell>
                      <StatusBadge status={actionStatus[a.status]} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Recent activity"
          actions={
            <Link href="/activity" className="text-xs font-medium text-primary hover:underline">
              View all
            </Link>
          }
        />
        {data.recentActivity.length === 0 ? (
          <EmptyState compact title="No activity yet" description="Imports, rule changes and automation events will be recorded here." />
        ) : (
          <div className="rounded-xl border border-border bg-card p-4">
            <Timeline>
              {data.recentActivity.map((item, i) => (
                <ActivityItem key={item.id} item={item} timeZone={ctx.timezone} last={i === data.recentActivity.length - 1} />
              ))}
            </Timeline>
          </div>
        )}
      </section>
    </>
  );
}

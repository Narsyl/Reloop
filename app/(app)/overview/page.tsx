import Link from "next/link";
import { ArrowRight, Plug } from "lucide-react";
import { requireOrg } from "@/lib/auth/tenancy";
import { getOverview } from "@/lib/domain/queries/overview";
import { customerName, formatNumber, formatRelative } from "@/lib/format";
import { dryRunState, exceptionSeverity } from "@/lib/status";
import { PageHeader, SectionHeader } from "@/components/layout/page-header";
import { Metric, MetricGrid } from "@/components/data/metric";
import { EmptyState } from "@/components/data/empty-state";
import { StatusBadge } from "@/components/status/status-badge";
import { Timeline } from "@/components/timeline/timeline";
import { ActivityItem } from "@/components/timeline/activity-item";
import { GiftRow } from "@/components/domain/gift-row";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Overview" };

export default async function OverviewPage() {
  const ctx = await requireOrg();
  const now = new Date();
  const data = await getOverview(ctx, now);

  if (!data.integration) {
    return (
      <>
        <PageHeader title="Overview" description="Connect your subscription platform to get started." />
        <EmptyState
          icon={Plug}
          title="Connect Recharge"
          description="Connecting imports your subscriptions and delivery history so Reloop can plan reward gifts. The import only reads. Nothing is written to Recharge until you turn automation on."
          action={
            <Button render={<Link href="/settings/integrations" />}>
              Connect Recharge <ArrowRight data-icon="inline-end" />
            </Button>
          }
        />
      </>
    );
  }

  const { integration, metrics } = data;
  const healthSentence = [
    integration.status === "CONNECTED" ? "Recharge is connected." : "Recharge needs attention.",
    integration.lastSuccessfulSyncAt ? `Last synced ${formatRelative(integration.lastSuccessfulSyncAt, now)}.` : "",
    integration.automationMode === "DRY_RUN"
      ? "Automation is in test mode."
      : integration.automationMode === "LIVE"
        ? "Automation is live."
        : "Automation is off.",
  ]
    .filter(Boolean)
    .join(" ");

  const attentionCount = metrics.reviewCount + metrics.openExceptions;

  return (
    <>
      <PageHeader title="Overview" description={healthSentence} />

      {attentionCount > 0 ? (
        <section className="overflow-hidden rounded-xl border border-status-danger/40 bg-card">
          <header className="flex items-center justify-between border-b border-status-danger/30 px-4 py-2">
            <h2 className="text-[11.5px] font-semibold tracking-wide text-status-danger uppercase">Needs attention</h2>
            <span className="tnum text-[11.5px] text-muted-foreground">{attentionCount}</span>
          </header>
          <ul>
            {data.reviewActions.map((a) => {
              const state = dryRunState(a, now);
              return (
                <li key={a.id} className="border-b border-border last:border-0">
                  <Link href={`/upcoming/${a.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{customerName(a.subscription.customer)}</span>
                      <span className="block truncate text-[13px] text-muted-foreground">{state.description}</span>
                    </span>
                    <StatusBadge status={state} />
                  </Link>
                </li>
              );
            })}
            {data.exceptions.map((e) => (
              <li key={e.id} className="border-b border-border last:border-0">
                <Link href="/activity?view=attention" className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{e.title}</span>
                    <span className="block truncate text-[13px] text-muted-foreground">
                      {e.subscription ? `${customerName(e.subscription.customer)}. ` : ""}
                      {e.description}
                    </span>
                  </span>
                  <StatusBadge status={exceptionSeverity[e.severity]} />
                </Link>
              </li>
            ))}
          </ul>
          {attentionCount > data.reviewActions.length + data.exceptions.length ? (
            <footer className="border-t border-border px-4 py-2">
              <Link href="/upcoming?view=review" className="text-xs font-medium text-primary hover:underline">
                View everything that needs review
              </Link>
            </footer>
          ) : null}
        </section>
      ) : null}

      <MetricGrid columns={3}>
        <Metric label="Gifts in the next 7 days" value={formatNumber(metrics.giftsNext7)} hint="Scheduled or already added" href="/upcoming" />
        <Metric label="Added in the last 30 days" value={formatNumber(metrics.added30)} hint="Gifts placed on renewals" href="/upcoming?view=added" />
        <Metric label="Active subscriptions" value={formatNumber(metrics.activeSubscriptions)} hint="Imported from Recharge" href="/subscriptions?status=ACTIVE" />
      </MetricGrid>

      <section className="space-y-3">
        <SectionHeader
          title="Next gifts"
          actions={
            <Link href="/upcoming" className="text-xs font-medium text-primary hover:underline">
              View the queue
            </Link>
          }
        />
        {data.nextGifts.length === 0 ? (
          <EmptyState compact title="No gifts queued" description="Gifts appear here as customers approach the next step of their reward journey." />
        ) : (
          <ul className="overflow-hidden rounded-xl border border-border bg-card">
            {data.nextGifts.map((a) => (
              <li key={a.id} className="border-b border-border last:border-0">
                <GiftRow action={a} state={dryRunState(a, now)} />
              </li>
            ))}
          </ul>
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
          <EmptyState compact title="No activity yet" description="Imports, checks and gifts will be recorded here." />
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

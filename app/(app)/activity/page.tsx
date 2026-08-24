import Link from "next/link";
import { Suspense } from "react";
import type { EntityType } from "@prisma/client";
import { Activity, ShieldCheck } from "lucide-react";
import { hasRole, requireOrg } from "@/lib/auth/tenancy";
import { ACTIVITY_PAGE_SIZE, listActivity } from "@/lib/domain/queries/activity";
import { listExceptions } from "@/lib/domain/queries/exceptions";
import { customerName } from "@/lib/format";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/data/empty-state";
import { Pagination } from "@/components/data/pagination";
import { ClearFilters, FilterBar, SearchFilter, SelectFilter } from "@/components/data/filter-bar";
import { Timeline } from "@/components/timeline/timeline";
import { ActivityItem } from "@/components/timeline/activity-item";
import { ExceptionCard, type ExceptionCardData } from "@/components/domain/exception-card";
import { cn } from "@/lib/utils";

export const metadata = { title: "Activity" };

const ENTITY_OPTIONS: { value: EntityType; label: string }[] = [
  { value: "SUBSCRIPTION", label: "Subscriptions" },
  { value: "JOURNEY", label: "Journeys" },
  { value: "ACTION", label: "Gifts" },
  { value: "EXCEPTION", label: "Attention items" },
  { value: "INTEGRATION", label: "Connections" },
  { value: "PROGRAM", label: "Programmes" },
  { value: "RULE", label: "Legacy rules" },
  { value: "FULFILLMENT_MARKER", label: "Legacy markers" },
  { value: "ORGANIZATION", label: "Workspace" },
];

export default async function ActivityPage({ searchParams }: PageProps<"/activity">) {
  const ctx = await requireOrg();
  const sp = await searchParams;
  const view = sp.view === "attention" ? "attention" : "feed";

  if (view === "attention") {
    const data = await listExceptions(ctx, { status: "OPEN", severity: "ALL" });
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
      action: e.action ? { id: e.action.id, markerName: e.action.rewardItem?.name ?? e.action.fulfillmentMarker?.name ?? "gift", targetCycle: e.action.targetCycle, targetChargeDate: e.action.targetChargeDate } : null,
      rule: e.rule,
      integration: e.integration,
      metadata: (e.metadataJson as Record<string, unknown> | null) ?? null,
    }));
    return (
      <>
        <PageHeader title="Activity" description="When Reloop is not confident it stops and asks instead of guessing. These items are waiting for a decision." />
        <ViewChips view={view} attentionCount={items.length} />
        {items.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="Nothing needs your attention" description="When something does, it will appear here with what happened and what to do." />
        ) : (
          <ul className="space-y-3">
            {items.map((item) => (
              <ExceptionCard key={item.id} item={item} timeZone={ctx.timezone} canResolve={hasRole(ctx, "OPERATOR")} />
            ))}
          </ul>
        )}
      </>
    );
  }

  const entityType = (typeof sp.entity === "string" ? sp.entity : "ALL") as EntityType | "ALL";
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const page = Number(sp.page ?? 1) || 1;
  const [data, attention] = await Promise.all([
    listActivity(ctx, { entityType, q, page }),
    listExceptions(ctx, { status: "OPEN", severity: "ALL" }),
  ]);

  return (
    <>
      <PageHeader title="Activity" description="Everything Reloop and your team have done, most recent first." />
      <ViewChips view={view} attentionCount={attention.rows.length} />
      <Suspense>
        <FilterBar>
          <SearchFilter placeholder="Search activity" />
          <SelectFilter name="entity" label="About" options={ENTITY_OPTIONS} />
          <ClearFilters />
        </FilterBar>
      </Suspense>
      {data.rows.length === 0 ? (
        <EmptyState icon={Activity} title="No activity matches" description="Try a different search, or clear the filters." />
      ) : (
        <div className="rounded-xl border border-border bg-card p-5">
          <Timeline>
            {data.rows.map((item, i) => (
              <ActivityItem key={item.id} item={item} timeZone={ctx.timezone} last={i === data.rows.length - 1} />
            ))}
          </Timeline>
        </div>
      )}
      <Pagination
        page={data.page}
        pages={data.pages}
        total={data.total}
        pageSize={ACTIVITY_PAGE_SIZE}
        basePath="/activity"
        params={{ entity: entityType === "ALL" ? undefined : entityType, q }}
      />
    </>
  );
}

function ViewChips({ view, attentionCount }: { view: "feed" | "attention"; attentionCount: number }) {
  const chip = (active: boolean) =>
    cn(
      "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition-colors",
      active ? "border-primary/30 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground",
    );
  return (
    <div className="mb-5 flex flex-wrap items-center gap-2">
      <Link href="/activity" className={chip(view === "feed")}>
        Feed
      </Link>
      <Link href={{ pathname: "/activity", query: { view: "attention" } }} className={chip(view === "attention")}>
        Needs attention
        {attentionCount > 0 ? <span className="tnum text-[11px] opacity-70">{attentionCount}</span> : null}
      </Link>
    </div>
  );
}

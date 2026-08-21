import { Suspense } from "react";
import type { EntityType } from "@prisma/client";
import { Activity } from "lucide-react";
import { requireOrg } from "@/lib/auth/tenancy";
import { ACTIVITY_PAGE_SIZE, listActivity } from "@/lib/domain/queries/activity";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/data/empty-state";
import { Pagination } from "@/components/data/pagination";
import { ClearFilters, FilterBar, SearchFilter, SelectFilter } from "@/components/data/filter-bar";
import { Timeline } from "@/components/timeline/timeline";
import { ActivityItem } from "@/components/timeline/activity-item";

export const metadata = { title: "Activity" };

const ENTITY_OPTIONS: { value: EntityType; label: string }[] = [
  { value: "SUBSCRIPTION", label: "Subscriptions" },
  { value: "JOURNEY", label: "Journeys" },
  { value: "ACTION", label: "Actions" },
  { value: "RULE", label: "Rules" },
  { value: "EXCEPTION", label: "Exceptions" },
  { value: "INTEGRATION", label: "Integrations" },
  { value: "PROGRAM", label: "Programs" },
  { value: "FULFILLMENT_MARKER", label: "Markers" },
  { value: "ORGANIZATION", label: "Organisation" },
];

export default async function ActivityPage({ searchParams }: PageProps<"/activity">) {
  const ctx = await requireOrg();
  const sp = await searchParams;
  const entityType = (typeof sp.entity === "string" ? sp.entity : "ALL") as EntityType | "ALL";
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const page = Number(sp.page ?? 1) || 1;
  const data = await listActivity(ctx, { entityType, q, page });

  return (
    <>
      <PageHeader title="Activity" description="Everything the platform and your team have done, in order. This is the human-readable history; raw webhook deliveries live with each integration." />
      <Suspense>
        <FilterBar>
          <SearchFilter placeholder="Search activity…" />
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

import Link from "next/link";
import { Suspense } from "react";
import type { SubscriptionStatus } from "@prisma/client";
import { Repeat } from "lucide-react";
import { requireOrg } from "@/lib/auth/tenancy";
import { SUBSCRIPTION_PAGE_SIZE, listProgramsForFilter, listSubscriptions } from "@/lib/domain/queries/subscriptions";
import { actionStatus, schedulingState, subscriptionStatus } from "@/lib/status";
import { customerName, formatDateOnly } from "@/lib/format";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/data/empty-state";
import { Pagination } from "@/components/data/pagination";
import { ClearFilters, FilterBar, SearchFilter, SelectFilter } from "@/components/data/filter-bar";
import { StatusBadge } from "@/components/status/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Subscriptions" };

export default async function SubscriptionsPage({ searchParams }: PageProps<"/subscriptions">) {
  const ctx = await requireOrg();
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const status = (typeof sp.status === "string" ? sp.status : "ALL") as SubscriptionStatus | "ALL";
  const programId = typeof sp.program === "string" ? sp.program : undefined;
  const mapping = (typeof sp.mapping === "string" ? sp.mapping : "ALL") as "MAPPED" | "UNMAPPED" | "ALL";
  const nextAction = (typeof sp.action === "string" ? sp.action : "ALL") as "ANY" | "NONE" | "ALL";
  const page = Number(sp.page ?? 1) || 1;

  const [data, programs] = await Promise.all([
    listSubscriptions(ctx, { q, status, programId, mapping, nextAction, page }),
    listProgramsForFilter(ctx),
  ]);

  return (
    <>
      <PageHeader
        title="Subscriptions"
        description="Every subscription imported from your platform, where each one is in its program journey, and what the automation plans next."
      />
      <Suspense>
        <FilterBar>
          <SearchFilter placeholder="Customer, email, ID, SKU, product…" />
          <SelectFilter
            name="status"
            label="Status"
            options={[
              { value: "ACTIVE", label: "Active" },
              { value: "PAUSED", label: "Paused" },
              { value: "CANCELLED", label: "Cancelled" },
              { value: "EXPIRED", label: "Expired" },
            ]}
          />
          <SelectFilter name="program" label="Program" options={programs.map((p) => ({ value: p.id, label: p.name }))} />
          <SelectFilter
            name="mapping"
            label="Mapping"
            options={[
              { value: "MAPPED", label: "Mapped to a program" },
              { value: "UNMAPPED", label: "Unmapped" },
            ]}
          />
          <SelectFilter
            name="action"
            label="Next action"
            options={[
              { value: "ANY", label: "Has queued action" },
              { value: "NONE", label: "No queued action" },
            ]}
          />
          <ClearFilters />
        </FilterBar>
      </Suspense>

      {data.rows.length === 0 ? (
        <EmptyState
          icon={Repeat}
          title={data.total === 0 && !q && status === "ALL" ? "No subscriptions yet" : "No subscriptions match"}
          description={
            data.total === 0 && !q && status === "ALL"
              ? "Connect your subscription platform to import subscriptions. The import is read-only."
              : "Try a different search or clear the filters."
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Completed cycles</TableHead>
                <TableHead>Next charge</TableHead>
                <TableHead>Next action</TableHead>
                <TableHead>Integration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((s) => {
                const next = s.actions[0];
                return (
                  <TableRow key={s.id}>
                    <TableCell>
                      <Link href={`/subscriptions/${s.id}`} className="block">
                        <span className="block font-medium hover:underline">{customerName(s.customer)}</span>
                        <span className="block truncate text-xs text-muted-foreground">{s.customer?.email ?? `#${s.externalSubscriptionId}`}</span>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span className="block">{s.productTitleSnapshot}</span>
                      <span className="block text-xs text-muted-foreground">
                        {s.latestJourney ? s.latestJourney.program.name : <StatusBadge status={{ label: "Unmapped", tone: "warning" }} />}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-col items-start gap-1">
                        <StatusBadge status={subscriptionStatus[s.status]} />
                        {schedulingState(s.status, s.nextChargeDate) && <StatusBadge status={schedulingState(s.status, s.nextChargeDate)!} dot={false} />}
                      </span>
                    </TableCell>
                    <TableCell className="tnum text-right">{s.latestJourney?.successfulCycles ?? "—"}</TableCell>
                    <TableCell className="tnum">{formatDateOnly(s.nextChargeDate)}</TableCell>
                    <TableCell>
                      {next ? (
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm">→ {next.rewardItem?.name ?? next.fulfillmentMarker?.name ?? "—"}</span>
                          <StatusBadge status={actionStatus[next.status]} dot={false} />
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{s.integration.displayName}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      <Pagination
        page={data.page}
        pages={data.pages}
        total={data.total}
        pageSize={SUBSCRIPTION_PAGE_SIZE}
        basePath="/subscriptions"
        params={{ q, status: status === "ALL" ? undefined : status, program: programId, mapping: mapping === "ALL" ? undefined : mapping, action: nextAction === "ALL" ? undefined : nextAction }}
      />
    </>
  );
}

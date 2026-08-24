import Link from "next/link";
import { Suspense } from "react";
import type { SubscriptionStatus } from "@prisma/client";
import { Repeat } from "lucide-react";
import { requireOrg } from "@/lib/auth/tenancy";
import { SUBSCRIPTION_PAGE_SIZE, listProgramsForFilter, listSubscriptions } from "@/lib/domain/queries/subscriptions";
import { actionStatus, subscriptionStatus } from "@/lib/status";
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
        description="Every subscription imported from Recharge, how far along each customer is, and the next gift on the way."
      />
      <Suspense>
        <FilterBar>
          <SearchFilter placeholder="Search customers and products" />
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
          <SelectFilter name="program" label="Programme" options={programs.map((p) => ({ value: p.id, label: p.name }))} />
          <SelectFilter
            name="mapping"
            label="Programme membership"
            options={[
              { value: "MAPPED", label: "In a programme" },
              { value: "UNMAPPED", label: "Not in a programme" },
            ]}
          />
          <SelectFilter
            name="action"
            label="Queued gift"
            options={[
              { value: "ANY", label: "Has a queued gift" },
              { value: "NONE", label: "No queued gift" },
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
              ? "Connect Recharge to import subscriptions. The import only reads and writes nothing back."
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
                <TableHead>Programme</TableHead>
                <TableHead className="text-right">Deliveries</TableHead>
                <TableHead>Next renewal</TableHead>
                <TableHead>Next gift</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((s) => {
                const next = s.actions[0];
                return (
                  <TableRow key={s.id}>
                    <TableCell>
                      <Link href={`/subscriptions/${s.id}`} className="block">
                        <span className="flex items-center gap-2">
                          <span className="font-medium hover:underline">{customerName(s.customer)}</span>
                          {s.status !== "ACTIVE" ? <StatusBadge status={subscriptionStatus[s.status]} dot={false} /> : null}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">{s.customer?.email ?? `Subscription ${s.externalSubscriptionId}`}</span>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span className="block max-w-56 truncate">{s.productTitleSnapshot}</span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.latestJourney ? s.latestJourney.program.name : <span className="text-status-warning">Not in a programme</span>}
                    </TableCell>
                    <TableCell className="tnum text-right">{s.latestJourney ? s.latestJourney.successfulCycles : ""}</TableCell>
                    <TableCell className="tnum">{s.nextChargeDate ? formatDateOnly(s.nextChargeDate) : <span className="text-muted-foreground">None scheduled</span>}</TableCell>
                    <TableCell>
                      {next ? (
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm">{next.rewardItem?.name ?? next.fulfillmentMarker?.name ?? "Gift"}</span>
                          <StatusBadge status={actionStatus[next.status]} dot={false} />
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">None planned</span>
                      )}
                    </TableCell>
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

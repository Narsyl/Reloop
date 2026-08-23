import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { requireOrg } from "@/lib/auth/tenancy";
import { getSubscriptionDetail } from "@/lib/domain/queries/subscriptions";
import { actionStatus, exceptionSeverity, schedulingState, subscriptionStatus } from "@/lib/status";
import { customerName, formatDate, formatDateOnly, formatDateTime, formatMoney, ordinal } from "@/lib/format";
import { PageHeader, SectionHeader } from "@/components/layout/page-header";
import { DetailList, DetailRow } from "@/components/data/detail-row";
import { EmptyState } from "@/components/data/empty-state";
import { StatusBadge } from "@/components/status/status-badge";
import { Timeline, TimelineItem } from "@/components/timeline/timeline";
import { ActivityItem } from "@/components/timeline/activity-item";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default async function SubscriptionDetailPage({ params }: PageProps<"/subscriptions/[id]">) {
  const ctx = await requireOrg();
  const { id } = await params;
  const data = await getSubscriptionDetail(ctx, id);
  if (!data) notFound();
  const { subscription: s, activity } = data;
  const journey = s.latestJourney;
  const liveActions = s.actions.filter((a) => ["PLANNED", "EXECUTING", "ATTACHED", "FAILED"].includes(a.status));
  const nextCycle = journey ? journey.successfulCycles + 1 : null;
  const nextAction = liveActions.find((a) => a.journeyId === journey?.id && a.targetCycle === nextCycle);
  const frequency = s.intervalFrequency && s.intervalUnit ? `Every ${s.intervalFrequency} ${s.intervalUnit}${s.intervalFrequency === 1 ? "" : "s"}` : "—";

  return (
    <>
      <PageHeader
        eyebrow={<Link href="/subscriptions" className="hover:underline">Subscriptions</Link>}
        title={s.productTitleSnapshot}
        meta={<><StatusBadge status={subscriptionStatus[s.status]} size="md" />{schedulingState(s.status, s.nextChargeDate) && <StatusBadge status={schedulingState(s.status, s.nextChargeDate)!} size="md" />}</>}
        description={
          <span>
            {customerName(s.customer)}
            {s.customer?.email ? ` · ${s.customer.email}` : ""} · {journey ? journey.program.name : "Not assigned to a program"}
          </span>
        }
        actions={
          <div className="text-right">
            <div className="text-xs text-muted-foreground">Next charge</div>
            <div className="tnum text-sm font-semibold">{formatDateOnly(s.nextChargeDate)}</div>
          </div>
        }
      />

      {s.exceptions.length > 0 && (
        <ul className="space-y-2">
          {s.exceptions.map((e) => (
            <li key={e.id} className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3">
              <StatusBadge status={exceptionSeverity[e.severity]} className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{e.title}</div>
                <div className="text-xs text-muted-foreground">{e.description}</div>
              </div>
              <Link href="/exceptions" className="text-xs font-medium text-primary hover:underline">Review</Link>
            </li>
          ))}
        </ul>
      )}

      <section className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="space-y-3 rounded-xl border border-border bg-card p-5">
          <SectionHeader
            title="Journey"
            description={journey ? `${journey.program.name} · started ${formatDate(journey.startedAt, ctx.timezone)}` : "No journey until the product is mapped to a program."}
          />
          {!journey ? (
            <EmptyState compact title="Unmapped" description="Assign this product to a subscription program to start counting delivery cycles." />
          ) : (
            <Timeline>
              {journey.cycles.map((c) => (
                <TimelineItem
                  key={c.id}
                  tone="success"
                  title={<span>Delivery {c.cycleNumber} <span className="text-muted-foreground">· processed</span></span>}
                  description={`${c.orderKind === "CHECKOUT" ? "Checkout order" : "Recurring order"} · ${c.source === "BACKFILL" ? "from history" : c.source.toLowerCase()}`}
                  time={formatDate(c.processedAt, ctx.timezone)}
                />
              ))}
              {s.status === "ACTIVE" && nextCycle && (
                <TimelineItem
                  tone={nextAction ? actionStatus[nextAction.status].tone : "neutral"}
                  last
                  title={<span>Delivery {nextCycle} <span className="text-muted-foreground">· upcoming</span></span>}
                  time={formatDateOnly(s.nextChargeDate)}
                  description={
                    nextAction ? (
                      <span className="flex items-center gap-2">
                        → {nextAction.rewardItem?.name ?? nextAction.fulfillmentMarker?.name ?? "—"} <StatusBadge status={actionStatus[nextAction.status]} />
                      </span>
                    ) : (
                      "No marker planned for this delivery."
                    )
                  }
                />
              )}
            </Timeline>
          )}
          {s.journeys.length > 1 && (
            <details className="group pt-2">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" /> Previous journeys ({s.journeys.length - 1})
              </summary>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {s.journeys.filter((j) => j.id !== journey?.id).map((j) => (
                  <li key={j.id}>
                    {j.program.name} · {j.successfulCycles} deliveries · {formatDate(j.startedAt, ctx.timezone)} → {formatDate(j.endedAt, ctx.timezone)}
                    {j.endReason ? ` · ended: ${j.endReason.toLowerCase().replace(/_/g, " ")}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>

        <div className="space-y-3 rounded-xl border border-border bg-card p-5">
          <SectionHeader title="Current subscription" />
          <DetailList columns={2}>
            <DetailRow label="Product">{s.productTitleSnapshot}</DetailRow>
            <DetailRow label="Variant">{s.variantTitleSnapshot ?? "—"}</DetailRow>
            <DetailRow label="SKU" mono>{s.skuSnapshot ?? "—"}</DetailRow>
            <DetailRow label="Quantity">{s.quantity}</DetailRow>
            <DetailRow label="Frequency">{frequency}</DetailRow>
            <DetailRow label="Price">{formatMoney(s.price, ctx.currency)}</DetailRow>
            <DetailRow label="Program">{journey?.program.name ?? "Unmapped"}</DetailRow>
            <DetailRow label="Completed cycles">{journey?.successfulCycles ?? "—"}</DetailRow>
            <DetailRow label="Next charge">{formatDateOnly(s.nextChargeDate)}</DetailRow>
            <DetailRow label="Integration">{s.integration.displayName}</DetailRow>
            <DetailRow label="Last synced">{formatDateTime(s.lastSyncedAt, ctx.timezone)}</DetailRow>
            <DetailRow label="Customer since">{formatDate(s.externalCreatedAt, ctx.timezone)}</DetailRow>
          </DetailList>
        </div>
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Order history"
          description="Successful orders imported from the subscription platform for this subscription — the facts delivery cycles are counted from. Compare against Recharge: each row is one processed order."
        />
        {s.orders.length === 0 ? (
          <EmptyState compact title="No imported orders" description="No successful orders have been imported for this subscription yet." />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Processed</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Product at the time</TableHead>
                  <TableHead>Counted as</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.orders.map((o) => {
                  const hit = s.journeys.flatMap((j) => j.cycles.map((c) => ({ j, c }))).find((x) => x.c.externalOrderId === o.externalOrderId);
                  return (
                    <TableRow key={o.id}>
                      <TableCell className="tnum">{formatDate(o.processedAt, ctx.timezone)}</TableCell>
                      <TableCell className="font-mono text-xs">#{o.externalOrderId}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{o.orderKind === "CHECKOUT" ? "Checkout" : "Recurring"}</TableCell>
                      <TableCell className="text-sm">{o.productTitle ?? o.externalProductId}<span className="ml-1 font-mono text-[11px] text-muted-foreground">{o.externalVariantId}</span></TableCell>
                      <TableCell className="text-sm">
                        {hit ? (
                          <span>Delivery <span className="tnum font-semibold">{hit.c.cycleNumber}</span> <span className="text-muted-foreground">· {hit.j.program.name}{s.journeys.length > 1 ? ` (journey ${hit.j.sequence})` : ""}</span></span>
                        ) : (
                          <span className="text-xs text-status-warning">not counted — product not mapped to a program</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader title="Actions" description="Every automation action for this subscription, newest first." />
        {s.actions.length === 0 ? (
          <EmptyState compact title="No actions yet" />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Marker</TableHead>
                  <TableHead className="text-right">Target cycle</TableHead>
                  <TableHead>Charge date</TableHead>
                  <TableHead>Rule</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.actions.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{a.rewardItem?.name ?? a.fulfillmentMarker?.name ?? "—"}</TableCell>
                    <TableCell className="tnum text-right">{ordinal(a.targetCycle)}</TableCell>
                    <TableCell className="tnum">{formatDateOnly(a.targetChargeDate)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {a.rule ? <Link href={`/rules/${a.rule.id}`} className="hover:underline">{a.rule.name}</Link> : a.source === "MANUAL" ? "Manual" : "—"}
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-col gap-0.5">
                        <StatusBadge status={actionStatus[a.status]} />
                        {a.lastError && <span className="max-w-xs truncate text-[11px] text-status-danger">{a.lastError}</span>}
                        {a.cancelReason && <span className="max-w-xs truncate text-[11px] text-muted-foreground">{a.cancelReason}</span>}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(a.updatedAt, ctx.timezone)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader title="Activity" />
        {activity.length === 0 ? (
          <EmptyState compact title="No activity recorded" />
        ) : (
          <div className="rounded-xl border border-border bg-card p-5">
            <Timeline>
              {activity.map((item, i) => (
                <ActivityItem key={item.id} item={item} timeZone={ctx.timezone} last={i === activity.length - 1} />
              ))}
            </Timeline>
          </div>
        )}
      </section>

      <details className="group rounded-xl border border-border bg-card">
        <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-3 text-sm font-medium">
          External references
          <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <div className="border-t border-border px-5 py-4">
          <DetailList columns={3}>
            <DetailRow label="Subscription ID" mono>{s.externalSubscriptionId}</DetailRow>
            <DetailRow label="Customer ID" mono>{s.externalCustomerId}</DetailRow>
            <DetailRow label="Address ID" mono>{s.externalAddressId}</DetailRow>
            <DetailRow label="Product ID" mono>{s.externalProductId}</DetailRow>
            <DetailRow label="Variant ID" mono>{s.externalVariantId}</DetailRow>
            <DetailRow label="Provider status" mono>{s.externalStatus ?? "—"}</DetailRow>
            {s.actions.filter((a) => a.externalObjectId).map((a) => (
              <DetailRow key={a.id} label={`One-time · ${a.rewardItem?.name ?? a.fulfillmentMarker?.name ?? "reward"}`} mono>{a.externalObjectId}</DetailRow>
            ))}
            <DetailRow label="Internal ID" mono>{s.id}</DetailRow>
          </DetailList>
        </div>
      </details>
    </>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrg } from "@/lib/auth/tenancy";
import { getSubscriptionDetail } from "@/lib/domain/queries/subscriptions";
import { resolveProgramRewards } from "@/lib/domain/rewards/resolver";
import { actionStatus, dryRunState, exceptionSeverity, schedulingState, subscriptionStatus } from "@/lib/status";
import { customerName, formatDate, formatDateOnly, formatDateTime, formatMoney } from "@/lib/format";
import { PageHeader, SectionHeader } from "@/components/layout/page-header";
import { DetailList, DetailRow } from "@/components/data/detail-row";
import { EmptyState } from "@/components/data/empty-state";
import { StatusBadge } from "@/components/status/status-badge";
import { Timeline } from "@/components/timeline/timeline";
import { ActivityItem } from "@/components/timeline/activity-item";
import { JourneyStrip } from "@/components/domain/journey-strip";
import { buildJourneyStops } from "@/lib/domain/journey-stops";
import { GiftRow } from "@/components/domain/gift-row";
import { TechnicalDetails, TechRow } from "@/components/data/technical-details";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Subscription" };

export default async function SubscriptionDetailPage({ params }: PageProps<"/subscriptions/[id]">) {
  const ctx = await requireOrg();
  const { id } = await params;
  const data = await getSubscriptionDetail(ctx, id);
  if (!data) notFound();
  const { subscription: s, activity } = data;
  const journey = s.latestJourney;
  const now = new Date();
  const nextCycle = journey ? journey.successfulCycles + 1 : null;
  const liveActions = s.actions.filter((a) => ["PLANNED", "EXECUTING", "ATTACHED", "FAILED"].includes(a.status));
  const nextAction = liveActions.find((a) => a.journeyId === journey?.id && a.targetCycle === nextCycle);
  const frequency = s.intervalFrequency && s.intervalUnit ? `every ${s.intervalFrequency === 1 ? "" : `${s.intervalFrequency} `}${s.intervalUnit.toLowerCase()}${s.intervalFrequency === 1 ? "" : "s"}` : null;

  const view = journey ? await resolveProgramRewards(ctx, journey.programId) : null;
  const stops = journey
    ? buildJourneyStops(view?.milestones ?? [], journey.successfulCycles, nextCycle, { addedAtTarget: nextAction?.status === "ATTACHED" })
    : [];

  const journeySentence = journey
    ? [
        `${journey.program.name}.`,
        journey.successfulCycles === 0 ? "No deliveries yet." : `${journey.successfulCycles === 1 ? "1 delivery" : `${journey.successfulCycles} deliveries`} so far.`,
        s.nextChargeDate ? `The next renewal is ${formatDateOnly(s.nextChargeDate)}${nextAction ? ` and includes the ${nextAction.rewardItem?.name ?? nextAction.fulfillmentMarker?.name ?? "gift"}` : ""}.` : "",
      ]
        .filter(Boolean)
        .join(" ")
    : "";

  return (
    <>
      <PageHeader
        eyebrow={<Link href="/subscriptions" className="hover:underline">Subscriptions</Link>}
        title={customerName(s.customer)}
        description={`${s.productTitleSnapshot}${frequency ? `, renewing ${frequency}` : ""}. ${s.customer?.email ?? ""}`}
        meta={
          <>
            <StatusBadge status={subscriptionStatus[s.status]} size="md" />
            {schedulingState(s.status, s.nextChargeDate) && <StatusBadge status={schedulingState(s.status, s.nextChargeDate)!} size="md" />}
          </>
        }
        actions={
          <div className="text-right">
            <div className="text-xs text-muted-foreground">Next renewal</div>
            <div className="tnum text-sm font-semibold">{s.nextChargeDate ? formatDateOnly(s.nextChargeDate) : "None scheduled"}</div>
          </div>
        }
      />

      {s.exceptions.length > 0 && (
        <ul className="mb-6 space-y-2">
          {s.exceptions.map((e) => (
            <li key={e.id} className="flex items-start gap-3 rounded-xl border border-status-danger/40 bg-card px-4 py-3">
              <StatusBadge status={exceptionSeverity[e.severity]} className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{e.title}</div>
                <div className="text-[13px] text-muted-foreground">{e.description}</div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <section className="mb-6 rounded-xl border border-border bg-card p-5">
        <div className="mb-1 text-[11.5px] font-semibold tracking-wide text-muted-foreground uppercase">Reward journey</div>
        {!journey ? (
          <p className="text-sm text-muted-foreground">
            This product is not part of a reward programme, so deliveries are not being counted. Add the product to a programme in Settings to start the journey.
          </p>
        ) : (
          <>
            <div className="mb-4 text-sm text-muted-foreground">{journeySentence}</div>
            {stops.length > 0 ? <JourneyStrip stops={stops} trailing /> : null}
          </>
        )}
        {s.journeys.length > 1 && (
          <p className="mt-4 text-xs text-muted-foreground">
            {s.journeys.length - 1 === 1 ? "One earlier journey" : `${s.journeys.length - 1} earlier journeys`} ended before this one. The full record is in the technical details below.
          </p>
        )}
      </section>

      <section className="mb-6 space-y-3">
        <SectionHeader title="Gifts" description="Every gift the automation has planned or added for this subscription." />
        {s.actions.length === 0 ? (
          <EmptyState compact title="No gifts yet" description="Gifts appear once the customer approaches a reward delivery." />
        ) : (
          <ul className="overflow-hidden rounded-xl border border-border bg-card">
            {s.actions.map((a) => {
              const programName = s.journeys.find((j) => j.id === a.journeyId)?.program.name ?? journey?.program.name ?? "programme";
              return (
                <li key={a.id} className="border-b border-border last:border-0">
                  <GiftRow
                    action={{ ...a, subscription: { customer: s.customer }, journey: { program: { name: programName } } }}
                    state={a.status === "PLANNED" ? dryRunState(a, now) : actionStatus[a.status]}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mb-6 grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          <SectionHeader title="Deliveries" description="Successful orders imported from Recharge. These are what the journey counts." />
          {s.orders.length === 0 ? (
            <EmptyState compact title="No orders imported yet" />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Processed</TableHead>
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
                        <TableCell className="tnum whitespace-nowrap">{formatDate(o.processedAt, ctx.timezone)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{o.orderKind === "CHECKOUT" ? "Checkout" : "Renewal"}</TableCell>
                        <TableCell className="max-w-48 truncate text-sm">{o.productTitle ?? o.externalProductId}</TableCell>
                        <TableCell className="text-sm">
                          {hit ? (
                            <span>
                              Delivery <span className="tnum font-semibold">{hit.c.cycleNumber}</span>
                              <span className="text-muted-foreground"> in {hit.j.program.name}</span>
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">Not counted. The product was not in a programme at the time.</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <SectionHeader title="Details" />
          <div className="rounded-xl border border-border bg-card p-5">
            <DetailList columns={1}>
              <DetailRow label="Product">{s.productTitleSnapshot}</DetailRow>
              {s.variantTitleSnapshot ? <DetailRow label="Variant">{s.variantTitleSnapshot}</DetailRow> : null}
              {s.skuSnapshot ? <DetailRow label="SKU" mono>{s.skuSnapshot}</DetailRow> : null}
              <DetailRow label="Quantity">{s.quantity}</DetailRow>
              {frequency ? <DetailRow label="Renews">{frequency.charAt(0).toUpperCase() + frequency.slice(1)}</DetailRow> : null}
              <DetailRow label="Price">{formatMoney(s.price, ctx.currency)}</DetailRow>
              <DetailRow label="Programme">{journey?.program.name ?? "Not in a programme"}</DetailRow>
              <DetailRow label="Deliveries">{journey?.successfulCycles ?? 0}</DetailRow>
              <DetailRow label="Customer since">{formatDate(s.externalCreatedAt, ctx.timezone)}</DetailRow>
              <DetailRow label="Last synced">{formatDateTime(s.lastSyncedAt, ctx.timezone)}</DetailRow>
            </DetailList>
          </div>
        </div>
      </section>

      <section className="mb-6 space-y-3">
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

      <TechnicalDetails>
        <TechRow label="Subscription">{s.externalSubscriptionId}</TechRow>
        <TechRow label="Customer">{s.externalCustomerId}</TechRow>
        <TechRow label="Address">{s.externalAddressId}</TechRow>
        <TechRow label="Product / variant">{s.externalProductId} / {s.externalVariantId}</TechRow>
        <TechRow label="Provider status">{s.externalStatus ?? "unknown"}</TechRow>
        <TechRow label="Integration">{s.integration.displayName} ({s.integration.provider}, {s.integration.automationMode})</TechRow>
        <TechRow label="Internal id">{s.id}</TechRow>
        {s.actions.filter((a) => a.externalObjectId).map((a) => (
          <TechRow key={a.id} label={`One-time (${a.rewardItem?.name ?? a.fulfillmentMarker?.name ?? "reward"})`}>
            {a.externalObjectType ?? "onetime"} {a.externalObjectId} on {a.externalChargeDate ?? "?"}
          </TechRow>
        ))}
        {s.journeys.map((j) => (
          <TechRow key={j.id} label={`Journey ${j.sequence}`}>
            {j.id} ({j.program.name}, {j.successfulCycles} cycles{j.endedAt ? `, ended ${j.endedAt.toISOString().slice(0, 10)}` : ", current"}
            {j.endReason ? `, ${j.endReason}` : ""})
          </TechRow>
        ))}
      </TechnicalDetails>
    </>
  );
}

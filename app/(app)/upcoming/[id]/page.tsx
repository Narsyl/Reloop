import Link from "next/link";
import { notFound } from "next/navigation";
import { hasRole, requireOrg } from "@/lib/auth/tenancy";
import { getActionDetail } from "@/lib/domain/queries/upcoming";
import type { DryRunResult } from "@/lib/domain/actions/dry-run";
import { actionStatus, automationMode, dryRunState, eligibilityScopeLabel, ruleStatus } from "@/lib/status";
import { customerName, formatDateOnly, formatDateTime, formatRelative } from "@/lib/format";
import { PageHeader, SectionHeader } from "@/components/layout/page-header";
import { StatusBadge } from "@/components/status/status-badge";
import { DryRunButton } from "@/components/domain/dry-run-button";
import { ActivityItem } from "@/components/timeline/activity-item";
import { EmptyState } from "@/components/data/empty-state";

export const metadata = { title: "Planned action" };

function Row({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[11rem_1fr] gap-3 border-b border-border py-2 text-sm last:border-0">
      <div className="text-muted-foreground">{label}</div>
      <div className={mono ? "font-mono text-xs" : ""}>{children}</div>
    </div>
  );
}

export default async function ActionDetailPage({ params }: PageProps<"/upcoming/[id]">) {
  const ctx = await requireOrg();
  const { id } = await params;
  const data = await getActionDetail(ctx, id);
  if (!data) notFound();
  const { action: a, activity } = data;
  const dr = (a.dryRunJson as unknown as DryRunResult | null) ?? null;
  const now = new Date();
  const canOperate = hasRole(ctx, "OPERATOR");

  return (
    <>
      <PageHeader
        eyebrow={<Link href="/upcoming" className="hover:underline">Upcoming</Link>}
        title={`${customerName(a.subscription.customer)} · ${a.journey.program.name} delivery ${a.targetCycle}`}
        description={`→ ${a.rewardItem?.name ?? a.fulfillmentMarker?.name ?? "reward"}${a.targetChargeDate ? ` · target charge ${formatDateOnly(a.targetChargeDate)}` : ""}`}
        meta={<><StatusBadge status={actionStatus[a.status]} size="md" /><StatusBadge status={dryRunState(a, now)} size="md" /><StatusBadge status={automationMode[a.integration.automationMode]} size="md" /></>}
        actions={canOperate && a.status === "PLANNED" ? <DryRunButton actionId={a.id} /> : undefined}
      />

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-4">
          <SectionHeader title="What is planned" />
          <Row label="Customer">{customerName(a.subscription.customer)}{a.subscription.customer?.email ? <span className="ml-2 text-xs text-muted-foreground">{a.subscription.customer.email}</span> : null}</Row>
          <Row label="Subscription"><Link href={`/subscriptions/${a.subscriptionId}`} className="hover:underline">{a.subscription.productTitleSnapshot}</Link> <span className="ml-1 font-mono text-xs text-muted-foreground">{a.subscription.externalSubscriptionId}</span> · {a.subscription.status}</Row>
          <Row label="Programme">{a.journey.program.name}</Row>
          <Row label="Journey cycles">{a.journey.successfulCycles} successful {a.journey.successfulCycles === 1 ? "delivery" : "deliveries"}{a.journey.cycles.length ? <span className="block text-xs text-muted-foreground">{a.journey.cycles.map((c) => `#${c.cycleNumber} order ${c.externalOrderId} · ${formatDateOnly(c.processedAt.toISOString().slice(0, 10))}`).join(" · ")}</span> : null}</Row>
          <Row label="Milestone">{a.milestone ? <><Link href={`/rewards/${a.milestone.schedule.id}`} className="hover:underline">{a.milestone.schedule.name}</Link> · delivery {a.milestone.cycleNumber} → <span className="font-medium">{a.milestone.rewardItem.name}</span> <span className="ml-1 text-xs text-muted-foreground">({a.milestone.executionMode === "INITIAL_CHECKOUT" ? "initial checkout" : "upcoming renewal"})</span></> : <span className="text-muted-foreground">—</span>}</Row>
          {a.rule ? <Row label="Legacy rule"><Link href={`/rules/${a.rule.id}`} className="hover:underline">{a.rule.name}</Link> <StatusBadge status={ruleStatus[a.rule.status]} /></Row> : null}
          <Row label="Eligibility scope">{a.eligibilityScope ? <>{eligibilityScopeLabel[a.eligibilityScope].label}<span className="block text-xs text-muted-foreground">{eligibilityScopeLabel[a.eligibilityScope].description}</span></> : "—"}</Row>
          <Row label="Target cycle">{a.targetCycle}</Row>
          <Row label="Target charge date">{a.targetChargeDate ? formatDateOnly(a.targetChargeDate) : "—"} <span className="ml-1 font-mono text-xs text-muted-foreground">{a.targetChargeDate}</span></Row>
          <Row label="Target charge at">{a.targetChargeAt ? <>{formatDateTime(a.targetChargeAt, ctx.timezone)} <span className="text-xs text-muted-foreground">(local midnight in {ctx.timezone})</span></> : "—"}</Row>
          <Row label="Execute after">{a.executeAfter ? <>{formatDateTime(a.executeAfter, ctx.timezone)} <span className="text-xs text-muted-foreground">({formatRelative(a.executeAfter, now)})</span></> : "—"}</Row>
          <Row label="Reward">{a.rewardItem?.name ?? a.fulfillmentMarker?.name ?? "—"}{a.fulfillmentMarker?.placeholder ? <span className="ml-2 text-xs text-status-warning">LEGACY PLACEHOLDER — not executable</span> : a.fulfillmentMarker ? <span className="ml-2 text-xs text-muted-foreground">legacy marker</span> : null}</Row>
          {dr?.target ? <Row label="Fulfilment variant (Shopify)"><span className="font-mono text-xs">{dr.target.externalVariantId}</span> · {dr.target.title}{dr.target.sku ? ` · SKU ${dr.target.sku}` : ""}</Row> : a.fulfillmentMarker ? <Row label="External variant id" mono>{a.fulfillmentMarker.externalVariantId}</Row> : null}
          <Row label="Recharge address id" mono>{a.externalAddressId ?? a.subscription.externalAddressId}</Row>
          <Row label="Planned">{formatDateTime(a.createdAt, ctx.timezone)}{a.plannerRun ? <span className="ml-1 text-xs text-muted-foreground">by the {a.plannerRun.trigger.toLowerCase()} planner run ({a.plannerRun.automationMode})</span> : null}{a.replanCount > 0 ? <span className="block text-xs text-muted-foreground">replanned ×{a.replanCount} · last evaluated {a.lastPlannedAt ? formatRelative(a.lastPlannedAt, now) : "—"}</span> : null}</Row>
          {a.cancelReason ? <Row label="Cancel reason">{a.cancelReason}</Row> : null}
          <Row label="Idempotency" mono>live {a.liveKey ?? "—"}<br />owner {a.ownerKey ?? "—"}</Row>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <SectionHeader title="Dry run" description="Fresh internal state + read-only Recharge reads → would we execute, and exactly what we would send. Never sent in this phase." />
          {!dr ? (
            <EmptyState compact title="Not dry-run yet" description={a.status === "PLANNED" ? "Runs automatically when the execute-after time is reached, or on demand." : "Only planned actions are dry-run."} />
          ) : (
            <div className="space-y-3 text-sm">
              <div className={`rounded-lg border p-3 ${dr.wouldExecute ? "border-status-success/40 bg-status-success-bg" : "border-status-warning/40 bg-status-warning-bg"}`}>
                <div className="text-base font-semibold">Would execute? {dr.wouldExecute ? "YES" : "NO"}</div>
                <div className="text-xs">{dr.wouldExecute ? `${dr.operation === "ADOPT_EXISTING_ONETIME" ? "Would adopt the existing one-time" : "Would create the one-time"} on ${dr.targetChargeDate} · ${dr.timing === "DUE" ? "due now" : "scheduled"}` : `Blocking reason: ${dr.blockingReason}${dr.blockingDetail ? ` — ${dr.blockingDetail}` : ""}`}</div>
                <div className="mt-1 text-[11px] text-muted-foreground">ran {formatDateTime(dr.ranAt, ctx.timezone)} · mode {dr.mode}</div>
              </div>
              <Row label="External subscription">{dr.external.read ? <>{dr.external.subscriptionStatus} · next charge <span className="font-mono text-xs">{dr.external.nextChargeDate ?? "—"}</span> · address <span className="font-mono text-xs">{dr.external.externalAddressId}</span></> : <span className="text-status-danger">read failed: {dr.external.error}</span>}</Row>
              <Row label="Existing marker one-time">{dr.external.existingMarkerOnetime ? <span className="font-mono text-xs">{dr.external.existingMarkerOnetime.externalOnetimeId} · {dr.external.existingMarkerOnetime.nextChargeDate}</span> : "none on this address/date"}</Row>
              <Row label="Lifetime deliveries">{dr.journey.lifetimeDeliveries} (customer, this programme)</Row>
              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Intended operation (NOT sent)</div>
                <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-[11px] leading-relaxed">{JSON.stringify({ provider: dr.intendedOperation.provider, apiVersion: dr.intendedOperation.apiVersion, method: dr.intendedOperation.method, path: dr.intendedOperation.path, body: dr.intendedOperation.body, sent: dr.intendedOperation.sent }, null, 2)}</pre>
                <p className="mt-1 text-xs text-muted-foreground">{dr.intendedOperation.note}</p>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="mt-6 space-y-2">
        <SectionHeader title="History" description="Every planner decision and dry run for this action." />
        {activity.length === 0 ? <EmptyState compact title="No activity recorded" /> : (
          <ol className="rounded-xl border border-border bg-card">
            {activity.map((item, i) => (
              <ActivityItem key={item.id} item={item} timeZone={ctx.timezone} last={i === activity.length - 1} />
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

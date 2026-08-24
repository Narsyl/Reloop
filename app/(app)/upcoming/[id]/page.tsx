import Link from "next/link";
import { notFound } from "next/navigation";
import { hasRole, requireOrg } from "@/lib/auth/tenancy";
import { getActionDetail } from "@/lib/domain/queries/upcoming";
import { resolveProgramRewards } from "@/lib/domain/rewards/resolver";
import type { DryRunResult } from "@/lib/domain/actions/dry-run";
import { actionStatus, blockerSentence, dryRunState } from "@/lib/status";
import { customerName, formatDateOnly, formatDateTime, formatRelative } from "@/lib/format";
import { giftSentence } from "@/lib/copy";
import { PageHeader, SectionHeader } from "@/components/layout/page-header";
import { StatusBadge } from "@/components/status/status-badge";
import { DryRunButton } from "@/components/domain/dry-run-button";
import { JourneyStrip } from "@/components/domain/journey-strip";
import { buildJourneyStops } from "@/lib/domain/journey-stops";
import { TechnicalDetails, TechRow } from "@/components/data/technical-details";
import { ActivityItem } from "@/components/timeline/activity-item";

export const metadata = { title: "Queued gift" };

export default async function ActionDetailPage({ params }: PageProps<"/upcoming/[id]">) {
  const ctx = await requireOrg();
  const { id } = await params;
  const data = await getActionDetail(ctx, id);
  if (!data) notFound();
  const { action: a, activity } = data;
  const dr = (a.dryRunJson as unknown as DryRunResult | null) ?? null;
  const now = new Date();
  const canOperate = hasRole(ctx, "OPERATOR");
  const name = customerName(a.subscription.customer);
  const state = a.status === "PLANNED" ? dryRunState(a, now) : actionStatus[a.status];

  // journey strip: the programme's schedule stops with this customer's progress
  const view = a.programId ? await resolveProgramRewards(ctx, a.programId) : null;
  const done = a.journey.successfulCycles;
  const stops = buildJourneyStops(view?.milestones ?? [], done, a.targetCycle, { addedAtTarget: a.status === "ATTACHED" });

  const checkSentence = (() => {
    if (a.status === "ATTACHED") return `The gift is on the ${a.targetChargeDate ? formatDateOnly(a.targetChargeDate) : "upcoming"} renewal in Recharge.`;
    if (a.status === "FULFILLED") return "The gift shipped with the renewal order.";
    if (a.status === "CANCELLED") return blockerSentence(a.cancelReason);
    if (a.status === "SUPERSEDED") return "The journey changed and a newer gift took the place of this one.";
    if (a.status === "FAILED") return blockerSentence(a.lastError);
    if (a.lastDryRunAt && a.wouldExecute === true) return `Checked against Recharge ${formatRelative(a.lastDryRunAt, now)}. Everything passed, and the gift will be added with the ${a.targetChargeDate ? formatDateOnly(a.targetChargeDate) : "next"} renewal.`;
    if (a.lastDryRunAt && a.wouldExecute === false) return blockerSentence(a.blockingReason);
    return "This gift has not been checked yet. It will be verified against Recharge automatically before the renewal.";
  })();

  return (
    <>
      <PageHeader
        eyebrow={<Link href="/upcoming" className="hover:underline">Upcoming</Link>}
        title={name}
        description={giftSentence(a)}
        meta={<StatusBadge status={state} size="md" />}
        actions={canOperate && a.status === "PLANNED" ? <DryRunButton actionId={a.id} /> : undefined}
      />

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="mb-1 flex items-baseline justify-between gap-3">
          <div className="text-[11.5px] font-semibold tracking-wide text-muted-foreground uppercase">Reward journey</div>
          <Link href={`/subscriptions/${a.subscriptionId}`} className="text-xs font-medium text-primary hover:underline">
            View subscription
          </Link>
        </div>
        <div className="mb-4 text-sm text-muted-foreground">
          {a.subscription.productTitleSnapshot}, {a.journey.program.name}. {done === 0 ? "No deliveries yet." : `${done === 1 ? "1 delivery" : `${done} deliveries`} so far.`}
          {a.targetChargeDate ? ` The next renewal is ${formatDateOnly(a.targetChargeDate)}.` : ""}
        </div>
        {stops.length > 0 ? <JourneyStrip stops={stops} trailing /> : null}
        <p className="mt-4 max-w-2xl text-sm">{checkSentence}</p>
      </section>

      <TechnicalDetails>
        <TechRow label="Action">{a.id}</TechRow>
        <TechRow label="Status (internal)">{a.status}{a.dryRun ? " (dry run)" : ""}</TechRow>
        <TechRow label="Subscription">{a.subscription.externalSubscriptionId}</TechRow>
        <TechRow label="Recharge address">{a.externalAddressId ?? a.subscription.externalAddressId}</TechRow>
        <TechRow label="Programme / milestone">{a.programId ?? "none"} / {a.rewardScheduleMilestoneId ?? "none"}{a.milestone ? ` (${a.milestone.schedule.name}, cycle ${a.milestone.cycleNumber}, ${a.milestone.eligibilityScope})` : ""}</TechRow>
        <TechRow label="Journey">{a.journeyId} at {a.journey.successfulCycles} cycles</TechRow>
        <TechRow label="Target">cycle {a.targetCycle} on {a.targetChargeDate ?? "?"} (executeAfter {a.executeAfter?.toISOString() ?? "not set"})</TechRow>
        <TechRow label="Reward / legacy marker">{a.rewardItem ? `${a.rewardItem.name} (${a.rewardItemId})` : "none"}{a.fulfillmentMarker ? ` / marker ${a.fulfillmentMarker.name} variant ${a.fulfillmentMarker.externalVariantId}` : ""}</TechRow>
        {dr?.target ? <TechRow label="Fulfilment variant">{dr.target.externalVariantId} (product {dr.target.externalProductId ?? "?"}) {dr.target.title}</TechRow> : null}
        <TechRow label="Idempotency">liveKey {a.liveKey ?? "freed"} / ownerKey {a.ownerKey ?? "freed"}</TechRow>
        <TechRow label="External object">{a.externalObjectType && a.externalObjectId ? `${a.externalObjectType} ${a.externalObjectId} on ${a.externalChargeDate ?? "?"}` : "none"}</TechRow>
        <TechRow label="Planner run">{a.plannerRun ? `${a.plannerRun.id} (${a.plannerRun.trigger}, ${formatDateTime(a.plannerRun.startedAt, ctx.timezone)})` : "none"}</TechRow>
        <TechRow label="Planned / replans">{a.lastPlannedAt ? formatDateTime(a.lastPlannedAt, ctx.timezone) : "?"} / {a.replanCount}</TechRow>
        <TechRow label="Last check (raw)">{a.lastDryRunAt ? `${a.lastDryRunAt.toISOString()} wouldExecute=${String(a.wouldExecute)}${a.blockingReason ? ` blocking=${a.blockingReason}` : ""}` : "never"}</TechRow>
        {a.cancelReason ? <TechRow label="Cancel reason">{a.cancelReason}</TechRow> : null}
        {a.lastError ? <TechRow label="Last error">{a.lastError}</TechRow> : null}
        {dr ? (
          <TechRow label="Intended payload">
            <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-background p-3 text-[11.5px] leading-relaxed">{JSON.stringify(dr.intendedOperation, null, 2)}</pre>
          </TechRow>
        ) : null}
      </TechnicalDetails>

      <section>
        <SectionHeader title="History" />
        {activity.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
        ) : (
          <ol className="space-y-1">
            {activity.map((e) => (
              <ActivityItem key={e.id} item={e} timeZone={ctx.timezone} />
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

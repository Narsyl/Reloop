import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { hasRole, requireOrg } from "@/lib/auth/tenancy";
import { listIntegrationsForAutomation, listUpcomingActions, type UpcomingAction } from "@/lib/domain/queries/upcoming";
import { listProgramsForFilter } from "@/lib/domain/queries/subscriptions";
import { actionStatus, dryRunState, type StatusMeta } from "@/lib/status";
import { pluralize } from "@/lib/format";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/data/empty-state";
import { SelectFilter } from "@/components/data/filter-bar";
import { RunPlannerButton } from "@/components/domain/automation-panel";
import { GiftRow } from "@/components/domain/gift-row";
import { cn } from "@/lib/utils";

export const metadata = { title: "Upcoming" };

type View = "all" | "review" | "added" | "scheduled";


function bucketOf(dateOnly: string | null, todayKey: string, weekEndKey: string): string {
  if (!dateOnly) return "Later";
  if (dateOnly < todayKey) return "Overdue";
  if (dateOnly === todayKey) return "Today";
  const tomorrow = nextDay(todayKey);
  if (dateOnly === tomorrow) return "Tomorrow";
  if (dateOnly <= weekEndKey) return "This week";
  return "Later";
}
function nextDay(key: string): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function addDays(key: string, n: number): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const BUCKET_ORDER = ["Overdue", "Today", "Tomorrow", "This week", "Later"];

export default async function UpcomingPage({ searchParams }: PageProps<"/upcoming">) {
  const ctx = await requireOrg();
  const sp = await searchParams;
  const view = (typeof sp.view === "string" && ["all", "review", "added", "scheduled"].includes(sp.view) ? sp.view : "all") as View;
  const programId = typeof sp.program === "string" ? sp.program : undefined;
  const [data, programs, integrations] = await Promise.all([
    listUpcomingActions(ctx, { status: "LIVE", programId }),
    listProgramsForFilter(ctx),
    listIntegrationsForAutomation(ctx),
  ]);
  const canManage = hasRole(ctx, "ADMIN");
  const now = new Date();
  const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: ctx.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const weekEndKey = addDays(todayKey, 6);

  const withState = data.rows.map((a) => ({ a, state: dryRunState(a, now) as StatusMeta }));
  const needsReview = (s: StatusMeta, a: UpcomingAction) => a.status === "FAILED" || s.label === "Needs review";
  const rows = withState.filter(({ a, state }) => {
    if (view === "review") return needsReview(state, a);
    if (view === "added") return a.status === "ATTACHED" || a.status === "FULFILLED";
    if (view === "scheduled") return a.status === "PLANNED" && !needsReview(state, a);
    return true;
  });

  const reviewRows = rows.filter(({ a, state }) => needsReview(state, a));
  const queueRows = rows.filter(({ a, state }) => !needsReview(state, a));
  const buckets = new Map<string, typeof queueRows>();
  for (const r of queueRows) {
    const b = bucketOf(r.a.targetChargeDate, todayKey, weekEndKey);
    buckets.set(b, [...(buckets.get(b) ?? []), r]);
  }
  const reviewCount = withState.filter(({ a, state }) => needsReview(state, a)).length;
  const mode = integrations.find((i) => i.status === "CONNECTED")?.automationMode;
  const modeSentence = mode === "DRY_RUN" ? "Test mode is on and nothing is written to Recharge." : mode === "OFF" ? "Automation is off." : mode === "LIVE" ? "Automation is live." : "";

  const chip = (v: View, label: string, count?: number) => (
    <Link
      key={v}
      href={{ pathname: "/upcoming", query: { ...(programId ? { program: programId } : {}), ...(v === "all" ? {} : { view: v }) } }}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition-colors",
        view === v ? "border-primary/30 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {label}
      {typeof count === "number" && count > 0 ? <span className="tnum text-[11px] opacity-70">{count}</span> : null}
    </Link>
  );

  return (
    <>
      <PageHeader
        title="Upcoming"
        description={`${pluralize(data.rows.length, "gift")} queued. ${modeSentence}`}
        actions={canManage && mode && mode !== "OFF" ? <RunPlannerButton integrationId={integrations.find((i) => i.status === "CONNECTED")!.id} size="xs" /> : undefined}
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        {chip("all", "All")}
        {chip("review", "Needs review", reviewCount)}
        {chip("added", "Added")}
        {chip("scheduled", "Scheduled")}
        <span className="ml-auto">
          <SelectFilter name="program" label="Programme" options={programs.map((p) => ({ value: p.id, label: p.name }))} />
        </span>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title={view === "review" ? "Nothing needs review" : "No gifts queued"}
          description={view === "review" ? "Every queued gift passed its latest check." : "Gifts appear here as customers approach the next step of their reward journey."}
        />
      ) : (
        <div className="space-y-5">
          {reviewRows.length > 0 && view !== "added" && view !== "scheduled" ? (
            <QueueGroup title="Needs review" tone="danger" rows={reviewRows} />
          ) : null}
          {BUCKET_ORDER.filter((b) => buckets.has(b)).map((b) => (
            <QueueGroup key={b} title={b} rows={buckets.get(b)!} />
          ))}
        </div>
      )}
    </>
  );
}

function QueueGroup({ title, rows, tone }: { title: string; rows: { a: UpcomingAction; state: StatusMeta }[]; tone?: "danger" }) {
  return (
    <section className={cn("overflow-hidden rounded-xl border bg-card", tone === "danger" ? "border-status-danger/40" : "border-border")}>
      <header className={cn("flex items-center justify-between border-b border-border px-4 py-2", tone === "danger" && "border-status-danger/30")}>
        <h2 className={cn("text-[11.5px] font-semibold tracking-wide uppercase", tone === "danger" ? "text-status-danger" : "text-muted-foreground")}>{title}</h2>
        <span className="tnum text-[11.5px] text-muted-foreground">{rows.length}</span>
      </header>
      <ul>
        {rows.map(({ a, state }) => (
          <li key={a.id} className="border-b border-border last:border-0">
            <GiftRow action={a} state={a.status === "PLANNED" ? state : actionStatus[a.status]} />
          </li>
        ))}
      </ul>
    </section>
  );
}

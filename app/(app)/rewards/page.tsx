import Link from "next/link";
import { Gift } from "lucide-react";
import { hasRole, requireOrg } from "@/lib/auth/tenancy";
import { listProgramsWithSchedules, listRewardItems, listRewardSchedules } from "@/lib/domain/rewards/queries";
import { rewardScheduleStatus } from "@/lib/status";
import { pluralize } from "@/lib/format";
import { PageHeader, SectionHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/data/empty-state";
import { StatusBadge } from "@/components/status/status-badge";
import { RewardItemDialog, ScheduleDialog } from "@/components/domain/reward-config";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Rewards" };

export default async function RewardsPage() {
  const ctx = await requireOrg();
  const [{ schedules, archived }, items, programs] = await Promise.all([listRewardSchedules(ctx), listRewardItems(ctx), listProgramsWithSchedules(ctx)]);
  const canManage = hasRole(ctx, "ADMIN");
  const unassigned = programs.filter((p) => p.active && !p.rewardSchedule);

  return (
    <>
      <PageHeader
        title="Rewards"
        description="Reward schedules are reusable milestone configuration (delivery number → reward item). Programmes share schedules but keep their own lifecycle and their own customer-programme reward history. Each programme binds its own fulfilment marker per milestone."
        actions={canManage ? <ScheduleDialog /> : undefined}
      />

      <section className="space-y-3">
        <SectionHeader title="Schedules" description={`${pluralize(schedules.length, "schedule")}${archived ? ` · ${archived} archived` : ""}${unassigned.length ? ` · ${unassigned.length} active programme(s) without a schedule: ${unassigned.map((p) => p.name).join(", ")}` : ""}`} />
        {schedules.length === 0 ? (
          <EmptyState icon={Gift} title="No reward schedules yet" description="Create a schedule, add its milestones (e.g. delivery 2 → Whisk, delivery 3 → Cup), then assign programmes and bind each programme's markers." action={canManage ? <ScheduleDialog /> : undefined} />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {schedules.map((s) => (
              <li key={s.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={`/rewards/${s.id}`} className="text-sm font-semibold hover:underline">{s.name}</Link>
                    {s.description ? <p className="text-xs text-muted-foreground">{s.description}</p> : null}
                  </div>
                  <StatusBadge status={rewardScheduleStatus[s.status]} />
                </div>
                <ol className="mt-3 space-y-1 text-sm">
                  {s.milestones.length === 0 ? <li className="text-xs text-muted-foreground">No milestones yet.</li> : s.milestones.map((m) => (
                    <li key={m.id} className="flex items-center gap-2">
                      <span className="tnum w-24 text-muted-foreground">Delivery {m.cycleNumber}</span>
                      <span className="font-medium">→ {m.rewardItem.name}</span>
                      <span className="text-[11px] text-muted-foreground">{m.executionMode === "INITIAL_CHECKOUT" ? "initial checkout · not planned" : "upcoming renewal"} · {m.eligibilityScope === "CUSTOMER_PROGRAM" ? "customer programme" : "per subscription"}{m.active ? "" : " · inactive"}</span>
                    </li>
                  ))}
                </ol>
                <p className="mt-3 text-xs text-muted-foreground">{s.programs.length === 0 ? "No programmes assigned." : `${pluralize(s.programs.length, "programme")}: ${s.programs.map((p) => p.name).join(", ")}`}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8 space-y-3">
        <SectionHeader title="Reward items" description="What physically happens — organisation-owned, reusable across schedules. A fulfilment marker also names its reward item so bindings are verifiable." actions={canManage ? <RewardItemDialog /> : undefined} />
        {items.length === 0 ? (
          <EmptyState compact title="No reward items yet" description="Create the rewards your schedules refer to (e.g. Whisk, Cup, Spoon)." />
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((i) => (
              <li key={i.id} className="flex items-start justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{i.name}{i.active ? "" : <span className="ml-2 text-[11px] text-muted-foreground">inactive</span>}</div>
                  <div className="text-xs text-muted-foreground">{i.operationalDescription ?? "—"} · used by {i._count.milestones} milestone(s), {i._count.markers} marker(s)</div>
                </div>
                {canManage ? <RewardItemDialog initial={{ id: i.id, name: i.name, description: i.description ?? "", operationalDescription: i.operationalDescription ?? "", active: i.active }} trigger={<Button size="xs" variant="ghost">Edit</Button>} /> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-8 text-xs text-muted-foreground">
        Legacy rules (pre-schedule configuration) are kept read-only for audit under <Link href="/rules" className="underline">Rules</Link>.
      </p>
    </>
  );
}

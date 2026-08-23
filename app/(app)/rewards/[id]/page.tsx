import Link from "next/link";
import { notFound } from "next/navigation";
import { hasRole, requireOrg } from "@/lib/auth/tenancy";
import { getRewardScheduleDetail, scheduleImpactMatrix } from "@/lib/domain/rewards/queries";
import { MILESTONE_READINESS_LABEL } from "@/lib/domain/rewards/resolver";
import { rewardScheduleStatus, executionModeLabel, eligibilityScopeLabel } from "@/lib/status";
import { pluralize } from "@/lib/format";
import { PageHeader, SectionHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/data/empty-state";
import { StatusBadge } from "@/components/status/status-badge";
import { Button } from "@/components/ui/button";
import { AssignProgramControl, DeleteMilestoneButton, MilestoneDialog, ScheduleDialog, ScheduleStatusControls, UnassignProgramButton } from "@/components/domain/reward-config";

export const metadata = { title: "Reward schedule" };

export default async function RewardScheduleDetailPage({ params }: PageProps<"/rewards/[id]">) {
  const ctx = await requireOrg();
  const { id } = await params;
  const data = await getRewardScheduleDetail(ctx, id);
  if (!data) notFound();
  const { schedule: s, items, unassignedPrograms, views } = data;
  const impact = await scheduleImpactMatrix(ctx, views);
  const canManage = hasRole(ctx, "ADMIN");
  const renewalMilestones = s.milestones.filter((m) => m.executionMode === "UPCOMING_RENEWAL");
  const cell = (programId: string, milestoneId: string) => impact.find((c) => c.programId === programId && c.milestoneId === milestoneId);
  const unboundRewards = [...new Set(views.flatMap((v) => v.milestones.filter((m) => m.executionMode === "UPCOMING_RENEWAL" && m.readinessReasons.includes("REWARD_UNBOUND")).map((m) => m.rewardItem.name)))];

  return (
    <>
      <PageHeader
        eyebrow={<Link href="/rewards" className="hover:underline">Rewards</Link>}
        title={s.name}
        description={s.description ?? "Reusable milestone configuration. Assign programmes; every milestone resolves through its physical reward item's Shopify binding — no per-programme setup."}
        meta={<StatusBadge status={rewardScheduleStatus[s.status]} size="md" />}
        actions={canManage ? <div className="flex flex-wrap items-center gap-2"><ScheduleDialog initial={{ id: s.id, name: s.name, description: s.description ?? "" }} trigger={<Button size="sm" variant="outline">Edit</Button>} /><ScheduleStatusControls id={s.id} name={s.name} status={s.status} programs={s.programs.length} /></div> : undefined}
      />

      <section className="space-y-3">
        <SectionHeader title="Milestones" description="Ordered by delivery number. Delivery 1 can only be an initial-checkout milestone: it is part of the first order by construction and is never planned by the renewal planner." actions={canManage && s.status !== "ARCHIVED" ? <MilestoneDialog scheduleId={s.id} items={items} /> : undefined} />
        {s.milestones.length === 0 ? (
          <EmptyState compact title="No milestones yet" description="Add the first milestone, e.g. delivery 2 → Whisk." />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground"><tr className="border-b border-border"><th className="px-3 py-2 font-medium">Delivery</th><th className="px-3 py-2 font-medium">Reward</th><th className="px-3 py-2 font-medium">Execution</th><th className="px-3 py-2 font-medium">Who counts</th><th className="px-3 py-2 font-medium">Actions planned</th><th className="px-3 py-2 font-medium">Notes</th><th className="px-3 py-2" /></tr></thead>
              <tbody>
                {s.milestones.map((m) => (
                  <tr key={m.id} className={`border-b border-border last:border-0 ${m.active ? "" : "opacity-60"}`}>
                    <td className="tnum px-3 py-2 font-semibold">{m.cycleNumber}</td>
                    <td className="px-3 py-2">{m.rewardItem.name}{m.rewardItem.operationalDescription ? <span className="block text-[11px] text-muted-foreground">{m.rewardItem.operationalDescription}</span> : null}</td>
                    <td className="px-3 py-2 text-xs">{executionModeLabel[m.executionMode].label}{m.executionMode === "INITIAL_CHECKOUT" ? <span className="block text-[11px] text-status-warning">not planned by the renewal planner</span> : null}</td>
                    <td className="px-3 py-2 text-xs">{eligibilityScopeLabel[m.eligibilityScope].label}</td>
                    <td className="tnum px-3 py-2 text-xs">{m._count.actions}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{m.notes ?? ""}{m.active ? "" : " (inactive)"}</td>
                    <td className="px-3 py-2 text-right">
                      {canManage && s.status !== "ARCHIVED" ? (
                        <span className="inline-flex items-center gap-1">
                          <MilestoneDialog scheduleId={s.id} items={items} initial={{ id: m.id, cycleNumber: m.cycleNumber, rewardItemId: m.rewardItemId, eligibilityScope: m.eligibilityScope, active: m.active, notes: m.notes ?? "" }} trigger={<Button size="xs" variant="ghost">Edit</Button>} />
                          {m._count.actions === 0 ? <DeleteMilestoneButton id={m.id} scheduleId={s.id} label={`delivery ${m.cycleNumber} → ${m.rewardItem.name}`} /> : null}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-8 space-y-3">
        <SectionHeader title="Programmes on this schedule" description={`${pluralize(s.programs.length, "programme")}. Each programme keeps its own journeys and its own customer-programme reward history; the schedule is configuration only. Milestones resolve through the shared reward items — bind Whisk / Cup / Spoon once under Rewards and every programme here uses the same variants.`} actions={canManage && s.status !== "ARCHIVED" ? <AssignProgramControl scheduleId={s.id} programs={unassignedPrograms} /> : undefined} />
        {views.length === 0 ? (
          <EmptyState compact title="No programmes assigned" />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-3 py-2 font-medium">Programme</th>
                  {s.milestones.map((m) => <th key={m.id} className="px-3 py-2 font-medium">Delivery {m.cycleNumber} → {m.rewardItem.name}</th>)}
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {views.map((v) => (
                  <tr key={v.programId} className="border-b border-border last:border-0 align-top">
                    <td className="px-3 py-2 font-medium">{v.programName}</td>
                    {v.milestones.map((m) => {
                      const c = cell(v.programId, m.milestoneId);
                      return (
                        <td key={m.milestoneId} className="px-3 py-2">
                          {m.executionMode === "INITIAL_CHECKOUT" ? (
                            <span className="text-xs text-muted-foreground">Initial checkout — part of the first order; not planned.</span>
                          ) : (
                            <div className="space-y-1">
                              <div className="text-xs">{m.binding && m.binding.active ? <>{m.rewardItem.name} → <span className="font-mono text-[11px]">{m.binding.externalVariantId}</span> <span className="text-muted-foreground">(&ldquo;{m.binding.externalTitle}&rdquo;)</span></> : <span className="text-muted-foreground">{m.rewardItem.name} — not bound yet</span>}</div>
                              <div className={`text-[11px] ${m.readiness === "READY" ? "text-status-success" : "text-status-warning"}`}>{m.readiness === "READY" ? "Ready — planner will plan it" : MILESTONE_READINESS_LABEL[m.readiness]}{m.readinessReasons.length > 1 ? ` (+${m.readinessReasons.length - 1} more)` : ""}</div>
                              {c ? <div className="tnum text-[11px] text-muted-foreground">{c.qualifyNow} would qualify now · {c.futureOnly} future · {c.alreadyPast} past{m.eligibilityScope === "CUSTOMER_PROGRAM" ? ` · ${c.alreadyReached} reached earlier` : ""} · {c.eligible}/{c.total} eligible</div> : null}
                            </div>
                          )}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-right">{canManage && s.status !== "ARCHIVED" ? <UnassignProgramButton programId={v.programId} programName={v.programName} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {unboundRewards.length > 0 ? <p className="text-xs text-muted-foreground">Rewards still unbound: {unboundRewards.join(", ")} — bind them under <Link href="/rewards" className="underline">Rewards → Reward fulfilment products</Link>.</p> : null}
        {renewalMilestones.length === 0 && s.milestones.length > 0 ? <p className="text-xs text-muted-foreground">This schedule has only initial-checkout milestones; nothing is planned by the renewal planner.</p> : null}
      </section>
    </>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { hasRole, requireOrg } from "@/lib/auth/tenancy";
import { getRewardScheduleDetail, scheduleImpactMatrix } from "@/lib/domain/rewards/queries";
import { MILESTONE_READINESS_LABEL } from "@/lib/domain/rewards/resolver";
import { rewardScheduleStatus, executionModeLabel, eligibilityScopeLabel } from "@/lib/status";
import { ordinal, pluralize } from "@/lib/format";
import { PageHeader, SectionHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/data/empty-state";
import { StatusBadge } from "@/components/status/status-badge";
import { JourneyStrip } from "@/components/domain/journey-strip";
import { Button } from "@/components/ui/button";
import { AssignProgramControl, DeleteMilestoneButton, MilestoneDialog, ScheduleDialog, ScheduleStatusControls, UnassignProgramButton } from "@/components/domain/reward-config";

export const metadata = { title: "Reward journey" };

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
        description={s.description ?? "Which delivery brings which gift. Programmes that use this journey share the same milestones."}
        meta={<StatusBadge status={rewardScheduleStatus[s.status]} size="md" />}
        actions={canManage ? <div className="flex flex-wrap items-center gap-2"><ScheduleDialog initial={{ id: s.id, name: s.name, description: s.description ?? "" }} trigger={<Button size="sm" variant="outline">Edit</Button>} /><ScheduleStatusControls id={s.id} name={s.name} status={s.status} programs={s.programs.length} /></div> : undefined}
      />

      {s.milestones.length > 0 ? (
        <section className="rounded-xl border border-border bg-card p-5">
          <JourneyStrip
            stops={s.milestones.map((m) => ({
              num: m.cycleNumber,
              label: `${ordinal(m.cycleNumber)} delivery`,
              sub: m.executionMode === "INITIAL_CHECKOUT" ? `${m.rewardItem.name} at checkout` : m.rewardItem.name,
              state: "future" as const,
            }))}
            trailing
          />
        </section>
      ) : null}

      <section className="space-y-3">
        <SectionHeader
          title="Milestones"
          description="The first delivery can only carry a checkout gift, because it ships with the order the customer placed themselves. Later gifts are added to the renewal before it charges."
          actions={canManage && s.status !== "ARCHIVED" ? <MilestoneDialog scheduleId={s.id} items={items} /> : undefined}
        />
        {s.milestones.length === 0 ? (
          <EmptyState compact title="No milestones yet" description="Add the first milestone, for example the Whisk with the 2nd delivery." />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground"><tr className="border-b border-border"><th className="px-3 py-2 font-medium">Delivery</th><th className="px-3 py-2 font-medium">Gift</th><th className="px-3 py-2 font-medium">When it happens</th><th className="px-3 py-2 font-medium">Who can earn it</th><th className="px-3 py-2 font-medium text-right">Gifts planned</th><th className="px-3 py-2 font-medium">Notes</th><th className="px-3 py-2" /></tr></thead>
              <tbody>
                {s.milestones.map((m) => (
                  <tr key={m.id} className={`border-b border-border last:border-0 ${m.active ? "" : "opacity-60"}`}>
                    <td className="tnum px-3 py-2 font-semibold">{ordinal(m.cycleNumber)}</td>
                    <td className="px-3 py-2">{m.rewardItem.name}{m.rewardItem.operationalDescription ? <span className="block text-[11px] text-muted-foreground">{m.rewardItem.operationalDescription}</span> : null}</td>
                    <td className="px-3 py-2 text-xs">{executionModeLabel[m.executionMode].label}</td>
                    <td className="px-3 py-2 text-xs">{eligibilityScopeLabel[m.eligibilityScope].label}</td>
                    <td className="tnum px-3 py-2 text-right text-xs">{m._count.actions}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{m.notes ?? ""}{m.active ? "" : " (inactive)"}</td>
                    <td className="px-3 py-2 text-right">
                      {canManage && s.status !== "ARCHIVED" ? (
                        <span className="inline-flex items-center gap-1">
                          <MilestoneDialog scheduleId={s.id} items={items} initial={{ id: m.id, cycleNumber: m.cycleNumber, rewardItemId: m.rewardItemId, eligibilityScope: m.eligibilityScope, active: m.active, notes: m.notes ?? "" }} trigger={<Button size="xs" variant="ghost">Edit</Button>} />
                          {m._count.actions === 0 ? <DeleteMilestoneButton id={m.id} scheduleId={s.id} label={`the ${ordinal(m.cycleNumber)} delivery ${m.rewardItem.name}`} /> : null}
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

      <section className="space-y-3">
        <SectionHeader
          title="Programmes on this journey"
          description={`${pluralize(s.programs.length, "programme")}. Each programme keeps its own customer history. The gifts resolve through the shared gift products, so binding a gift once covers every programme here.`}
          actions={canManage && s.status !== "ARCHIVED" ? <AssignProgramControl scheduleId={s.id} programs={unassignedPrograms} /> : undefined}
        />
        {views.length === 0 ? (
          <EmptyState compact title="No programmes assigned" />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-3 py-2 font-medium">Programme</th>
                  {s.milestones.map((m) => <th key={m.id} className="px-3 py-2 font-medium">{m.rewardItem.name} with the {ordinal(m.cycleNumber)} delivery</th>)}
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {views.map((v) => (
                  <tr key={v.programId} className="border-b border-border align-top last:border-0">
                    <td className="px-3 py-2 font-medium">{v.programName}</td>
                    {v.milestones.map((m) => {
                      const c = cell(v.programId, m.milestoneId);
                      return (
                        <td key={m.milestoneId} className="px-3 py-2">
                          {m.executionMode === "INITIAL_CHECKOUT" ? (
                            <span className="text-xs text-muted-foreground">Ships with the first order, so nothing is planned.</span>
                          ) : (
                            <div className="space-y-1">
                              <div className="text-xs">
                                {m.binding && m.binding.active ? (
                                  <>Linked to &ldquo;{m.binding.externalTitle}&rdquo;</>
                                ) : (
                                  <span className="text-muted-foreground">Not linked to a product yet</span>
                                )}
                              </div>
                              <div className={`text-[11px] ${m.readiness === "READY" ? "text-status-success" : "text-status-warning"}`}>
                                {m.readiness === "READY" ? "Ready to plan" : MILESTONE_READINESS_LABEL[m.readiness]}
                              </div>
                              {c ? (
                                <div className="tnum text-[11px] text-muted-foreground">
                                  {c.qualifyNow} would qualify now, {c.eligible} of {c.total} eligible
                                </div>
                              ) : null}
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
        {unboundRewards.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Still to link: {unboundRewards.join(", ")}. Link them under <Link href="/rewards" className="underline">Gift products</Link>.
          </p>
        ) : null}
        {renewalMilestones.length === 0 && s.milestones.length > 0 ? <p className="text-xs text-muted-foreground">Every milestone here ships with the first order, so the planner has nothing to schedule.</p> : null}
      </section>
    </>
  );
}

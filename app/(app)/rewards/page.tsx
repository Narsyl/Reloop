import Link from "next/link";
import { Gift } from "lucide-react";
import { hasRole, requireOrg } from "@/lib/auth/tenancy";
import { listProgramsWithSchedules, listRewardItems, listRewardSchedules } from "@/lib/domain/rewards/queries";
import { listRewardBindings } from "@/lib/domain/rewards/bindings";
import { RewardBindingsTable } from "@/components/domain/reward-bindings";
import { rewardScheduleStatus } from "@/lib/status";
import { PageHeader, SectionHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/data/empty-state";
import { StatusBadge } from "@/components/status/status-badge";
import { JourneyStrip } from "@/components/domain/journey-strip";
import { RewardItemDialog, ScheduleDialog } from "@/components/domain/reward-config";
import { ordinal } from "@/lib/format";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Rewards" };

export default async function RewardsPage() {
  const ctx = await requireOrg();
  const [{ schedules, archived }, items, programs, bindings] = await Promise.all([listRewardSchedules(ctx), listRewardItems(ctx), listProgramsWithSchedules(ctx), listRewardBindings(ctx)]);
  const canManage = hasRole(ctx, "ADMIN");
  const unassigned = programs.filter((p) => p.active && !p.rewardSchedule);

  return (
    <>
      <PageHeader
        title="Rewards"
        description="The journey of gifts customers earn as their deliveries add up."
        actions={canManage ? <ScheduleDialog /> : undefined}
      />

      <section className="space-y-3">
        <SectionHeader
          title="Reward journeys"
          description={
            unassigned.length
              ? `Some active programmes have no journey yet: ${unassigned.map((p) => p.name).join(", ")}.`
              : "Each journey is a reusable set of milestones that programmes share."
          }
        />
        {schedules.length === 0 ? (
          <EmptyState
            icon={Gift}
            title="No reward journeys yet"
            description="Create a journey and choose which delivery brings which gift, for example the Whisk with the 2nd delivery and the Cup with the 3rd."
            action={canManage ? <ScheduleDialog /> : undefined}
          />
        ) : (
          <ul className="space-y-3">
            {schedules.map((s) => (
              <li key={s.id} className="rounded-xl border border-border bg-card p-5">
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={`/rewards/${s.id}`} className="text-sm font-semibold hover:underline">{s.name}</Link>
                    <p className="text-[13px] text-muted-foreground">
                      {s.programs.length === 0
                        ? "Not used by any programme yet."
                        : s.programs.length === 1
                          ? `Used by ${s.programs[0].name}.`
                          : `Used by ${s.programs.slice(0, -1).map((p) => p.name).join(", ")} and ${s.programs[s.programs.length - 1].name}.`}
                    </p>
                  </div>
                  <StatusBadge status={rewardScheduleStatus[s.status]} />
                </div>
                {s.milestones.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">No milestones yet. Open the journey to add the first gift.</p>
                ) : (
                  <JourneyStrip
                    stops={s.milestones.map((m) => ({
                      label: `${ordinal(m.cycleNumber)} delivery`,
                      sub: m.executionMode === "INITIAL_CHECKOUT" ? `${m.rewardItem.name} at checkout` : m.rewardItem.name,
                      state: "future" as const,
                    }))}
                    trailing
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        {archived ? <p className="text-xs text-muted-foreground">{archived === 1 ? "One archived journey is" : `${archived} archived journeys are`} kept for the audit record.</p> : null}
      </section>

      <section className="mt-8 space-y-3">
        <SectionHeader
          title="Gift products"
          description={
            bindings.shopifyIntegrations.length === 0
              ? "Connect Shopify in Settings to link each gift to the product that ships. The connection only reads your catalogue."
              : `Each gift links to one existing product on ${bindings.shopifyIntegrations.map((s) => s.shopDomain).join(", ")}. Nothing is created or changed in Shopify.`
          }
          actions={bindings.shopifyIntegrations.length === 0 ? <Button size="sm" variant="outline" render={<Link href="/settings/integrations" />}>Connect Shopify</Button> : undefined}
        />
        <RewardBindingsTable rows={bindings.rows} canManage={canManage} />
      </section>

      <section className="mt-8 space-y-3">
        <SectionHeader
          title="Gift items"
          description="The gifts themselves. Create them once and reuse them across journeys."
          actions={canManage ? <RewardItemDialog /> : undefined}
        />
        {items.length === 0 ? (
          <EmptyState compact title="No gifts yet" description="Create the gifts your journeys award, for example the Whisk, the Cup and the Spoon." />
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((i) => (
              <li key={i.id} className="flex items-start justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {i.name}
                    {i.active ? "" : <span className="ml-2 text-[11px] text-muted-foreground">inactive</span>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {i.operationalDescription ? `${i.operationalDescription}. ` : ""}
                    {i._count.milestones === 0 ? "Not used by any journey yet." : `Used by ${i._count.milestones === 1 ? "1 milestone" : `${i._count.milestones} milestones`}.`}
                  </div>
                </div>
                {canManage ? <RewardItemDialog initial={{ id: i.id, name: i.name, description: i.description ?? "", operationalDescription: i.operationalDescription ?? "", active: i.active }} trigger={<Button size="xs" variant="ghost">Edit</Button>} /> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

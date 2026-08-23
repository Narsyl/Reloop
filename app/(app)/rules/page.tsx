import Link from "next/link";
import { Plus, SlidersHorizontal } from "lucide-react";
import { hasRole, requireOrg } from "@/lib/auth/tenancy";
import { listRules } from "@/lib/domain/queries/rules";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/data/empty-state";
import { RuleRow } from "@/components/domain/rule-row";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Rules" };

export default async function RulesPage() {
  const ctx = await requireOrg();
  const { rules, archived } = await listRules(ctx);
  const canManage = hasRole(ctx, "ADMIN");

  return (
    <>
      <PageHeader
        title="Rules"
        description="Legacy configuration, kept read-only for audit. Milestones are now configured once on a reusable reward schedule and resolved per programme by the planner."
        actions={
          <Button render={<Link href="/rewards" />}>
            <Plus data-icon="inline-start" /> Reward schedules
          </Button>
        }
      />
      <div className="rounded-xl border border-status-info/30 bg-status-info-bg px-4 py-3 text-sm text-status-info">
        Rules are legacy: they are never planned from. Each rule here is either archived (migrated to a schedule milestone — see its activity) or awaiting archival. Configure rewards under <Link href="/rewards" className="underline">Rewards</Link>.
      </div>
      {rules.length === 0 ? (
        <EmptyState
          icon={SlidersHorizontal}
          title="No legacy rules"
          description="Reward configuration lives under Rewards (schedules → milestones → programme marker bindings)."
          action={
            <Button render={<Link href="/rewards" />} disabled={!canManage}>
              <Plus data-icon="inline-start" /> Reward schedules
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {rules.map((r) => (
            <RuleRow
              key={r.id}
              canManage={canManage}
              rule={{
                id: r.id,
                name: r.name,
                status: r.status,
                cycleNumber: r.cycleNumber,
                programName: r.program.name,
                markerName: r.fulfillmentMarker.name,
                markerTitle: r.fulfillmentMarker.title,
                markerSku: r.fulfillmentMarker.sku,
                eligibilityScope: r.eligibilityScope,
                liveActions: r.liveActions,
              }}
            />
          ))}
        </ul>
      )}
      {archived > 0 && <p className="text-xs text-muted-foreground">{archived} archived rule{archived === 1 ? "" : "s"} hidden.</p>}
    </>
  );
}

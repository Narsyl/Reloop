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
        description="A rule says: when a subscription programme reaches a delivery cycle, add a fulfilment marker to the next shipment. Rules are drafted, validated and previewed here; none can plan or execute actions until the automation engine is enabled."
        actions={
          <Button render={<Link href="/rules/new" />} disabled={!canManage}>
            <Plus data-icon="inline-start" /> New rule
          </Button>
        }
      />
      <div className="rounded-xl border border-status-info/30 bg-status-info-bg px-4 py-3 text-sm text-status-info">
        Automation engine not enabled for this organisation — rules can be Draft, Ready or Disabled. Nothing is written to your subscription platform.
      </div>
      {rules.length === 0 ? (
        <EmptyState
          icon={SlidersHorizontal}
          title="No rules yet"
          description="Create your first rule: choose a subscription programme, the delivery cycle (2 or later), the fulfilment marker, and who counts towards the milestone — then review the impact preview built from your real subscriptions."
          action={
            <Button render={<Link href="/rules/new" />} disabled={!canManage}>
              <Plus data-icon="inline-start" /> New rule
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

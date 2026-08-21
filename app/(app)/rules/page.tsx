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
  const rules = await listRules(ctx);
  const canManage = hasRole(ctx, "ADMIN");

  return (
    <>
      <PageHeader
        title="Rules"
        description="Each rule says: when a subscription program reaches a delivery cycle, add a fulfilment marker to the upcoming shipment. Rules start disabled until you activate them."
        actions={
          <Button render={<Link href="/rules/new" />} disabled={!canManage}>
            <Plus data-icon="inline-start" /> New rule
          </Button>
        }
      />
      {rules.length === 0 ? (
        <EmptyState
          icon={SlidersHorizontal}
          title="No rules yet"
          description="Create your first rule once products are mapped to subscription programs and a fulfilment marker exists. Example: Morning Magic Powder · delivery 2 → Morning Magic 2."
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
                enabled: r.enabled,
                cycleNumber: r.cycleNumber,
                programName: r.program.name,
                markerName: r.fulfillmentMarker.name,
                markerSku: r.fulfillmentMarker.variant.sku,
                liveActions: r.liveActions,
                totalActions: r._count.actions,
                lastTriggeredAt: r.lastTriggeredAt,
              }}
            />
          ))}
        </ul>
      )}
    </>
  );
}

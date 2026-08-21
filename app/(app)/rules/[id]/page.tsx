import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrg } from "@/lib/auth/tenancy";
import { getRule } from "@/lib/domain/queries/rules";
import { actionStatus, enabledStatus } from "@/lib/status";
import { customerName, formatDateOnly, formatDateTime } from "@/lib/format";
import { PageHeader, SectionHeader } from "@/components/layout/page-header";
import { RuleSummary } from "@/components/domain/rule-summary";
import { StatusBadge } from "@/components/status/status-badge";
import { DetailList, DetailRow } from "@/components/data/detail-row";
import { EmptyState } from "@/components/data/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default async function RuleDetailPage({ params }: PageProps<"/rules/[id]">) {
  const ctx = await requireOrg();
  const { id } = await params;
  const rule = await getRule(ctx, id);
  if (!rule) notFound();

  return (
    <>
      <PageHeader
        eyebrow={<Link href="/rules" className="hover:underline">Rules</Link>}
        title={rule.name}
        meta={<StatusBadge status={enabledStatus(rule.enabled)} size="md" />}
        description={rule.description ?? undefined}
      />

      <section className="rounded-xl border border-border bg-card p-5">
        <RuleSummary programName={rule.program.name} cycleNumber={rule.cycleNumber} markerName={rule.fulfillmentMarker.name} />
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3 rounded-xl border border-border bg-card p-5">
          <SectionHeader title="Subscription program" description="Products and variants that share this milestone journey." />
          <p className="text-sm font-medium">{rule.program.name}</p>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {rule.program.products.map((pp) => (
              <li key={pp.id}>
                {pp.product.title}
                {pp.variant ? ` · ${pp.variant.title}${pp.variant.sku ? ` (${pp.variant.sku})` : ""}` : " · all variants"}
              </li>
            ))}
            {rule.program.products.length === 0 && <li>No products mapped yet.</li>}
          </ul>
        </div>
        <div className="space-y-3 rounded-xl border border-border bg-card p-5">
          <SectionHeader title="Fulfilment marker" description="The £0 item inserted into the shipment." />
          <DetailList columns={2}>
            <DetailRow label="Marker">{rule.fulfillmentMarker.name}</DetailRow>
            <DetailRow label="External item">{rule.fulfillmentMarker.variant.product.title} · {rule.fulfillmentMarker.variant.title}</DetailRow>
            <DetailRow label="SKU" mono>{rule.fulfillmentMarker.variant.sku ?? "—"}</DetailRow>
            <DetailRow label="Operational note">{rule.fulfillmentMarker.description ?? "—"}</DetailRow>
          </DetailList>
        </div>
      </section>

      <section className="space-y-3">
        <SectionHeader title="Recent actions from this rule" />
        {rule.actions.length === 0 ? (
          <EmptyState compact title="No actions yet" description="Actions appear here as subscriptions approach this rule's delivery cycle." />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead className="text-right">Cycle</TableHead>
                  <TableHead>Charge date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rule.actions.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <Link href={`/subscriptions/${a.subscriptionId}`} className="font-medium hover:underline">
                        {customerName(a.subscription.customer)}
                      </Link>
                    </TableCell>
                    <TableCell className="tnum text-right">{a.targetCycle}</TableCell>
                    <TableCell className="tnum">{formatDateOnly(a.targetChargeDate)}</TableCell>
                    <TableCell><StatusBadge status={actionStatus[a.status]} /></TableCell>
                    <TableCell className="text-muted-foreground">{formatDateTime(a.createdAt, ctx.timezone)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </>
  );
}

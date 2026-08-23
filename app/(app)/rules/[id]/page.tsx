import Link from "next/link";
import { notFound } from "next/navigation";
import { hasRole, requireOrg } from "@/lib/auth/tenancy";
import { getRule, getRuleBuilderOptions } from "@/lib/domain/queries/rules";
import { analyzeMilestoneImpact } from "@/lib/domain/rules/impact";
import { eligibilityScopeLabel, ruleStatus } from "@/lib/status";
import { formatDateTime } from "@/lib/format";
import { PageHeader, SectionHeader } from "@/components/layout/page-header";
import { RuleSummary } from "@/components/domain/rule-summary";
import { RuleBuilder } from "@/components/domain/rule-builder";
import { ImpactPanel } from "@/components/domain/impact-panel";
import { StatusBadge } from "@/components/status/status-badge";
import { DetailList, DetailRow } from "@/components/data/detail-row";

export default async function RuleDetailPage({ params, searchParams }: PageProps<"/rules/[id]">) {
  const ctx = await requireOrg();
  const { id } = await params;
  const sp = await searchParams;
  const rule = await getRule(ctx, id);
  if (!rule) notFound();
  const canManage = hasRole(ctx, "ADMIN");
  const editing = sp.edit === "1" && canManage && rule.status !== "ACTIVE" && rule.status !== "ARCHIVED";
  const [options, impact] = await Promise.all([editing ? getRuleBuilderOptions(ctx) : null, analyzeMilestoneImpact(ctx, { programId: rule.programId, cycleNumber: rule.cycleNumber, fulfillmentMarkerId: rule.fulfillmentMarkerId })]);

  return (
    <>
      <PageHeader
        eyebrow={<Link href="/rules" className="hover:underline">Rules</Link>}
        title={rule.name}
        meta={<StatusBadge status={ruleStatus[rule.status]} size="md" />}
        description={rule.description ?? undefined}
        actions={canManage && !editing && rule.status !== "ARCHIVED" && rule.status !== "ACTIVE" ? <Link href={`/rules/${rule.id}?edit=1`} className="text-sm font-medium text-primary hover:underline">Edit</Link> : undefined}
      />

      {editing && options ? (
        <RuleBuilder
          options={options}
          canManage={canManage}
          initial={{ id: rule.id, name: rule.name, description: rule.description ?? "", programId: rule.programId, cycleNumber: rule.cycleNumber, fulfillmentMarkerId: rule.fulfillmentMarkerId, eligibilityScope: rule.eligibilityScope, status: rule.status }}
        />
      ) : (
        <>
          <section className="rounded-xl border border-border bg-card p-5">
            <RuleSummary programName={rule.program.name} cycleNumber={rule.cycleNumber} markerName={rule.fulfillmentMarker.title ?? rule.fulfillmentMarker.name} />
            <DetailList columns={3} className="mt-4">
              <DetailRow label="Who counts">{rule.eligibilityScope ? eligibilityScopeLabel[rule.eligibilityScope].label : "Not chosen yet"}</DetailRow>
              <DetailRow label="Marker">{rule.fulfillmentMarker.name} · {rule.fulfillmentMarker.title ?? "—"}{rule.fulfillmentMarker.sku ? ` (${rule.fulfillmentMarker.sku})` : ""}</DetailRow>
              <DetailRow label="External variant" mono>{rule.fulfillmentMarker.externalVariantId} · {rule.fulfillmentMarker.integration.displayName}</DetailRow>
              <DetailRow label="Created">{formatDateTime(rule.createdAt, ctx.timezone)}</DetailRow>
              <DetailRow label="Updated">{formatDateTime(rule.updatedAt, ctx.timezone)}</DetailRow>
              <DetailRow label="Status">{ruleStatus[rule.status].description}</DetailRow>
            </DetailList>
          </section>
          <section className="space-y-3">
            <SectionHeader title="Activation impact analysis" description="Calculated now from imported subscriptions. Preview only — nothing is planned." />
            <ImpactPanel impact={impact} markerName={rule.fulfillmentMarker.title ?? rule.fulfillmentMarker.name} />
          </section>
        </>
      )}
    </>
  );
}

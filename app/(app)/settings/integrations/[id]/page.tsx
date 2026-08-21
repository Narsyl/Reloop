import Link from "next/link";
import { notFound } from "next/navigation";
import { hasRole, requireOrg } from "@/lib/auth/tenancy";
import { getCycleAuditSample, getIntegrationDetail } from "@/lib/domain/queries/integrations";
import { automationMode, integrationStatus } from "@/lib/status";
import { customerName, formatDate, formatDateOnly, formatDateTime, formatNumber, formatRelative } from "@/lib/format";
import { PageHeader, SectionHeader } from "@/components/layout/page-header";
import { DetailList, DetailRow } from "@/components/data/detail-row";
import { Metric, MetricGrid } from "@/components/data/metric";
import { EmptyState } from "@/components/data/empty-state";
import { StatusBadge } from "@/components/status/status-badge";
import { IntegrationActions } from "@/components/domain/integration-actions";
import { SyncStatus, type SyncStatusData } from "@/components/domain/sync-status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { CapabilityMap } from "@/lib/integrations/types";

const REQUIRED: { key: keyof CapabilityMap; label: string }[] = [
  { key: "store", label: "Store information" },
  { key: "customers", label: "Customers" },
  { key: "products", label: "Products" },
  { key: "orders", label: "Orders" },
  { key: "subscriptions", label: "Subscriptions" },
  { key: "onetimes", label: "One-times" },
  { key: "webhooks", label: "Webhooks" },
];
const OPTIONAL: { key: keyof CapabilityMap; label: string }[] = [
  { key: "charges", label: "Charges (verification)" },
  { key: "events", label: "Events API" },
  { key: "credits", label: "Credits" },
  { key: "customer_sessions", label: "Storefront sessions" },
];
const capLabel = (v: string | undefined) =>
  !v || v === "unavailable" ? "unavailable on current plan / no permission" : v === "unknown" ? "could not verify" : v === "read_write" ? "read / write" : v === "derived" ? "derived from subscriptions & orders" : v;

function toSyncData(s: NonNullable<Awaited<ReturnType<typeof getIntegrationDetail>>>["syncs"][number]): SyncStatusData {
  return { id: s.id, kind: s.kind, status: s.status, stage: s.stage, error: s.error, progress: (s.progressJson as SyncStatusData["progress"]) ?? {}, counts: (s.countsJson as Record<string, number>) ?? {}, startedAt: s.startedAt?.toISOString() ?? null, finishedAt: s.finishedAt?.toISOString() ?? null };
}

export default async function IntegrationDetailPage({ params }: PageProps<"/settings/integrations/[id]">) {
  const ctx = await requireOrg();
  const { id } = await params;
  const data = await getIntegrationDetail(ctx, id);
  if (!data) notFound();
  const { integration: i, syncs, stats, activeSync } = data;
  const caps = (i.capabilitiesJson as CapabilityMap | null) ?? null;
  const requiredOk = caps ? REQUIRED.every((c) => caps[c.key] !== "unavailable" && caps[c.key] !== "unknown") : false;
  const settings = (i.settingsJson as { scopes?: string[] | null; notes?: string[]; store?: { domain?: string | null; currency?: string | null; timezone?: string | null; email?: string | null } } | null) ?? null;
  const audit = i.status !== "DISCONNECTED" ? await getCycleAuditSample(ctx, i.id, 10) : [];
  const latest = syncs[0];

  return (
    <>
      <PageHeader
        eyebrow={<Link href="/settings/integrations" className="hover:underline">Integrations</Link>}
        title={i.displayName}
        meta={<><StatusBadge status={integrationStatus[i.status]} size="md" /><StatusBadge status={automationMode[i.automationMode]} size="md" /></>}
        description={<span>Recharge · {i.externalStoreId}{settings?.store?.currency ? ` · ${settings.store.currency}` : ""}{settings?.store?.timezone ? ` · ${settings.store.timezone}` : ""} · connected {formatDate(i.createdAt, ctx.timezone)}</span>}
        actions={i.status !== "DISCONNECTED" ? <IntegrationActions integrationId={i.id} displayName={i.displayName} canManage={hasRole(ctx, "ADMIN")} canOperate={hasRole(ctx, "OPERATOR")} syncRunning={!!activeSync} hasSynced={!!i.lastSuccessfulSyncAt} /> : undefined}
      />

      <MetricGrid>
        <Metric label="Subscriptions imported" value={formatNumber(stats.subscriptions)} hint={`${formatNumber(stats.active)} active · ${formatNumber(stats.inactive)} inactive`} href="/subscriptions" />
        <Metric label="Active · mapped to a program" value={formatNumber(stats.mappedActive)} hint={stats.active ? `${Math.round((stats.mappedActive / stats.active) * 100)}% of active` : "—"} href="/subscriptions?mapping=MAPPED&status=ACTIVE" />
        <Metric label="Active · unmapped" value={formatNumber(stats.unmappedActive)} tone={stats.unmappedActive > 0 ? "warning" : "default"} hint={stats.unmappedActive > 0 ? `${stats.unmappedProducts} product${stats.unmappedProducts === 1 ? "" : "s"} need a program` : "Everything is assigned"} href="/subscriptions?mapping=UNMAPPED&status=ACTIVE" />
        <Metric label="Historical order lines" value={formatNumber(stats.orderLines)} hint={stats.unlinkedOrderLines > 0 ? `${formatNumber(stats.unlinkedOrderLines)} for subscriptions not imported` : `${formatNumber(stats.customers)} customers · ${formatNumber(stats.products)} products / ${formatNumber(stats.variants)} variants`} />
      </MetricGrid>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3 rounded-xl border border-border bg-card p-5">
          <SectionHeader title="Capabilities" description={`Probed empirically — what this token can actually read on this store's plan.${i.capabilitiesCheckedAt ? ` Checked ${formatRelative(i.capabilitiesCheckedAt)}.` : ""}`} />
          <p className={`text-sm font-medium ${requiredOk ? "text-status-success" : "text-status-danger"}`}>{requiredOk ? "All features required by Subscription Ops are available." : "Some required capabilities are missing — rules cannot be activated until they are granted."}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <ul className="space-y-1 text-sm">
              <li className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Required</li>
              {REQUIRED.map((c) => {
                const v = caps?.[c.key];
                const ok = v && v !== "unavailable" && v !== "unknown";
                return (
                  <li key={c.key} className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2"><span className={`size-2 rounded-full ${ok ? "bg-status-success" : "bg-status-danger"}`} />{c.label}</span>
                    <span className="text-xs text-muted-foreground">{capLabel(v)}</span>
                  </li>
                );
              })}
            </ul>
            <ul className="space-y-1 text-sm text-muted-foreground">
              <li className="text-[11px] font-semibold tracking-wide uppercase">Optional · never required</li>
              {OPTIONAL.map((c) => {
                const v = caps?.[c.key];
                const ok = v && v !== "unavailable" && v !== "unknown";
                return (
                  <li key={c.key} className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2"><span className={`size-2 rounded-full ${ok ? "bg-status-success" : "bg-border"}`} />{c.label}</span>
                    <span className="text-xs">{capLabel(v)}</span>
                  </li>
                );
              })}
            </ul>
          </div>
          {settings?.notes && settings.notes.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">{settings.notes.map((n, idx) => <li key={idx}>{n}</li>)}</ul>
          )}
        </div>

        <div className="space-y-3 rounded-xl border border-border bg-card p-5">
          <SectionHeader title={latest ? (latest.kind === "INITIAL" ? "Latest import" : latest.kind === "INCREMENTAL" ? "Latest sync" : "Latest journey recalculation") : "Sync"} description={latest ? `${latest.status.toLowerCase()}${latest.startedAt ? ` · started ${formatDateTime(latest.startedAt, ctx.timezone)}` : ""}${latest.finishedAt ? ` · finished ${formatRelative(latest.finishedAt)}` : ""}` : "No sync has run yet."} />
          {latest ? <SyncStatus sync={toSyncData(latest)} /> : <EmptyState compact title="Not synced yet" description="Start the read-only import to bring in products, customers, subscriptions and order history." />}
        </div>
      </section>

      <section className="space-y-3">
        <SectionHeader title="Cycle audit sample" description="Active, mapped subscriptions with the most history — compare each row with the order history in Recharge. 'Our cycle N' must equal the number of successful orders for that subscription's program journey." />
        {audit.length === 0 ? (
          <EmptyState compact title="Nothing to audit yet" description="Once subscriptions are imported and mapped to programs, a sample appears here." />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Subscription ID</TableHead>
                  <TableHead>Program</TableHead>
                  <TableHead className="text-right">Our cycle</TableHead>
                  <TableHead className="text-right">Orders (this journey)</TableHead>
                  <TableHead className="text-right">Orders (all history)</TableHead>
                  <TableHead>Order ids · dates</TableHead>
                  <TableHead>Next charge</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {audit.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell><Link href={`/subscriptions/${s.id}`} className="font-medium hover:underline">{customerName(s.customer)}</Link></TableCell>
                    <TableCell className="font-mono text-xs">{s.externalSubscriptionId}</TableCell>
                    <TableCell className="text-muted-foreground">{s.currentJourney?.program.name}{s.journeys.length > 1 ? <span className="ml-1 text-xs">(journey {s.journeys.length})</span> : null}</TableCell>
                    <TableCell className="tnum text-right font-semibold">{s.currentJourney?.successfulCycles ?? "—"}</TableCell>
                    <TableCell className="tnum text-right">{s.currentJourney?.cycles.length ?? 0}</TableCell>
                    <TableCell className="tnum text-right">{s.orders.length}</TableCell>
                    <TableCell className="max-w-xs">
                      <div className="flex flex-wrap gap-1">
                        {(s.currentJourney?.cycles ?? []).map((c) => (
                          <span key={c.id} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]" title={`cycle ${c.cycleNumber} · ${c.orderKind.toLowerCase()}`}>
                            #{c.externalOrderId} · {formatDate(c.processedAt, ctx.timezone, { year: undefined })}
                          </span>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="tnum">{formatDateOnly(s.nextChargeDate)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader title="Sync history" description="Every import, sync and recalculation run, with where it stopped and what it counted." />
        {syncs.length === 0 ? (
          <EmptyState compact title="No runs yet" />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Counts</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {syncs.map((s) => {
                  const c = (s.countsJson as Record<string, number> | null) ?? {};
                  const dur = s.startedAt && s.finishedAt ? Math.round((s.finishedAt.getTime() - s.startedAt.getTime()) / 1000) : null;
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="text-sm">{s.kind === "INITIAL" ? "Initial import" : s.kind === "INCREMENTAL" ? "Sync" : "Recalculate journeys"}</TableCell>
                      <TableCell><StatusBadge status={{ label: s.status.toLowerCase(), tone: s.status === "COMPLETED" ? "success" : s.status === "FAILED" ? "danger" : s.status === "RUNNING" ? "info" : "neutral" }} /></TableCell>
                      <TableCell className="text-xs text-muted-foreground">{s.stage.toLowerCase()}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatDateTime(s.startedAt ?? s.createdAt, ctx.timezone)}</TableCell>
                      <TableCell className="tnum text-xs text-muted-foreground">{dur === null ? "—" : dur < 60 ? `${dur}s` : `${Math.round(dur / 60)}m`}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {s.kind === "RECALCULATE_JOURNEYS"
                          ? `${c.journeysProcessed ?? 0} subs · ${c.mapped ?? 0} mapped · ${c.unmapped ?? 0} unmapped`
                          : `${c.subscriptions ?? 0} subs · ${c.customers ?? 0} cust · ${c.products ?? 0} prod · ${c.orders ?? 0} orders · ${c.mapped ?? 0}/${c.unmapped ?? 0} mapped/unmapped`}
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-xs text-status-danger" title={s.error ?? undefined}>{s.error ?? ""}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <details className="group rounded-xl border border-border bg-card">
        <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-3 text-sm font-medium">External references</summary>
        <div className="border-t border-border px-5 py-4">
          <DetailList columns={3}>
            <DetailRow label="Store id / domain" mono>{i.externalStoreId}</DetailRow>
            <DetailRow label="Store email">{settings?.store?.email ?? "—"}</DetailRow>
            <DetailRow label="Token scopes" mono>{settings?.scopes?.join(", ") ?? "not exposed"}</DetailRow>
            <DetailRow label="Integration id" mono>{i.id}</DetailRow>
          </DetailList>
        </div>
      </details>
    </>
  );
}

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
import { AutomationModeControl, RunPlannerButton } from "@/components/domain/automation-panel";
import { ShopifyCapabilityPanel } from "@/components/domain/shopify-capability-panel";
import { RecheckShopifyButton } from "@/components/domain/connect-shopify-dialog";
import { RewardBindingsTable } from "@/components/domain/reward-bindings";
import { listRewardBindings } from "@/lib/domain/rewards/bindings";
import type { ShopifyCapabilityReport } from "@/lib/integrations/shopify";
import type { ShopifyIntegrationSettings } from "@/lib/domain/integrations/shopify";
import { listPlannerRuns } from "@/lib/domain/queries/upcoming";
import { getWebhookPanelState, listRecentWebhookEvents } from "@/lib/domain/webhooks/recharge";
import { RegisterWebhooksControl, WebhookSecretDialog } from "@/components/domain/webhook-panel";
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
  if (i.provider === "SHOPIFY") {
    const report = (i.capabilitiesJson as ShopifyCapabilityReport | null) ?? null;
    const settings = (i.settingsJson as Partial<ShopifyIntegrationSettings> | null) ?? null;
    const bindings = await listRewardBindings(ctx);
    const rows = bindings.rows.filter((r) => r.shopify?.id === i.id);
    const canManage = hasRole(ctx, "ADMIN");
    return (
      <>
        <PageHeader
          eyebrow={<Link href="/settings/integrations" className="hover:underline">Integrations</Link>}
          title={i.displayName}
          description="Shopify provides catalogue access so each gift can link to the product that ships. The connection only reads. Recharge remains the subscription authority."
          meta={<StatusBadge status={integrationStatus[i.status]} size="md" />}
          actions={canManage ? <RecheckShopifyButton integrationId={i.id} /> : undefined}
        />
        <section className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-3">
            <SectionHeader title="Store & authentication" />
            <DetailList>
              <DetailRow label="Shop">{settings?.store?.name ?? i.displayName}</DetailRow>
              <DetailRow label="myshopify domain"><span className="font-mono text-xs">{settings?.shopDomain ?? i.externalStoreId}</span></DetailRow>
              <DetailRow label="Primary domain">{settings?.store?.primaryDomainHost ?? "none"}</DetailRow>
              <DetailRow label="Currency / plan">{settings?.store?.currencyCode ?? "unknown"}{settings?.store?.planDisplayName ? ", " + settings.store.planDisplayName : ""}</DetailRow>
              <DetailRow label="Admin API version">{settings?.apiVersion ?? "none"}</DetailRow>
              <DetailRow label="Authentication">{settings?.authMode === "CLIENT_CREDENTIALS" ? "Client credentials (server-side token exchange)" : (settings?.authMode ?? "none")}</DetailRow>
              <DetailRow label="Client ID"><span className="font-mono text-xs">{settings?.clientIdHint ?? "none"}</span></DetailRow>
              <DetailRow label="Client secret"><span className="font-mono text-xs">••••••••••••</span></DetailRow>
              <DetailRow label="Access token">{i.accessTokenExpiresAt ? `short lived, refreshes automatically, the current one expires ${formatRelative(i.accessTokenExpiresAt)}` : "obtained on first use"}</DetailRow>
              <DetailRow label="Serves Recharge store">{i.pairedIntegration ? <Link href={"/settings/integrations/" + i.pairedIntegration.id} className="hover:underline">{i.pairedIntegration.displayName}</Link> : <span className="text-status-warning">not paired</span>}</DetailRow>
              <DetailRow label="Capabilities checked">{i.capabilitiesCheckedAt ? formatDateTime(i.capabilitiesCheckedAt, ctx.timezone) : "never"}</DetailRow>
              {i.lastErrorMessage ? <DetailRow label="Last error"><span className="text-status-danger">{i.lastErrorMessage}</span></DetailRow> : null}
            </DetailList>
          </div>
          <div className="space-y-3">
            <SectionHeader title="Capabilities (least privilege)" />
            {report ? <ShopifyCapabilityPanel report={report} compact /> : <EmptyState compact title="No capability report yet" />}
          </div>
        </section>
        <section className="mt-6 space-y-3">
          <SectionHeader title="Reward fulfilment products on this store" description="Each gift links to one existing Shopify product. Every journey that awards the gift uses that product, and verifying only reads it again." />
          <RewardBindingsTable rows={rows} canManage={canManage} />
        </section>
      </>
    );
  }
  const caps = (i.capabilitiesJson as CapabilityMap | null) ?? null;
  const requiredOk = caps ? REQUIRED.every((c) => caps[c.key] !== "unavailable" && caps[c.key] !== "unknown") : false;
  const settings = (i.settingsJson as { scopes?: string[] | null; notes?: string[]; store?: { domain?: string | null; currency?: string | null; timezone?: string | null; email?: string | null } } | null) ?? null;
  const audit = i.status !== "DISCONNECTED" ? await getCycleAuditSample(ctx, i.id, 10) : [];
  const plannerRuns = i.status !== "DISCONNECTED" ? await listPlannerRuns(ctx, { integrationId: i.id, take: 8 }) : [];
  const webhooks = i.status !== "DISCONNECTED" ? await getWebhookPanelState(ctx, i.id) : null;
  const webhookEvents = i.status !== "DISCONNECTED" ? await listRecentWebhookEvents(ctx, i.id, 12) : [];
  const defaultBaseUrl = webhooks?.registration?.baseUrl ?? "";
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
        <Metric label="Active and in a programme" value={formatNumber(stats.mappedActive)} hint={stats.active ? `${Math.round((stats.mappedActive / stats.active) * 100)}% of active` : undefined} href="/subscriptions?mapping=MAPPED&status=ACTIVE" />
        <Metric label="Active but not in a programme" value={formatNumber(stats.unmappedActive)} tone={stats.unmappedActive > 0 ? "warning" : "default"} hint={stats.unmappedActive > 0 ? `${stats.unmappedProducts} product${stats.unmappedProducts === 1 ? "" : "s"} need a programme` : "Everything is assigned"} href="/subscriptions?mapping=UNMAPPED&status=ACTIVE" />
        <Metric label="Historical order lines" value={formatNumber(stats.orderLines)} hint={stats.unlinkedOrderLines > 0 ? `${formatNumber(stats.unlinkedOrderLines)} for subscriptions not imported` : `${formatNumber(stats.customers)} customers · ${formatNumber(stats.products)} products / ${formatNumber(stats.variants)} variants`} />
      </MetricGrid>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3 rounded-xl border border-border bg-card p-5">
          <SectionHeader title="Capabilities" description={`What this token can actually read on this store's plan, probed directly.${i.capabilitiesCheckedAt ? ` Checked ${formatRelative(i.capabilitiesCheckedAt)}.` : ""}`} />
          <p className={`text-sm font-medium ${requiredOk ? "text-status-success" : "text-status-danger"}`}>{requiredOk ? "Everything Reloop needs is available." : "Some required capabilities are missing. Automation cannot run until they are granted."}</p>
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
              <li className="text-[11px] font-semibold tracking-wide uppercase">Optional, never required</li>
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
          <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
            <span className="font-medium">One-time products</span>
            <span className="ml-2">Read {caps && caps.onetimes && caps.onetimes !== "unavailable" && caps.onetimes !== "unknown" ? <span className="text-status-success">yes</span> : <span className="text-status-danger">no</span>}</span>
            <span className="ml-3">Write {caps?.onetimes === "read_write" ? <span className="text-status-success">yes</span> : <span className="text-status-danger">missing</span>}</span>
            <span className="ml-2 block text-xs text-muted-foreground">{caps?.onetimes === "read_write" ? "write_subscriptions is granted, so a single armed gift can be written when you approve one. Unrestricted live mode stays off." : "POST /onetimes needs the write_subscriptions permission on the Recharge token. Update the token's permissions in Recharge, then run Test connection again. No write is attempted until granted."}</span>
          </p>
          {settings?.notes && settings.notes.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">{settings.notes.map((n, idx) => <li key={idx}>{n}</li>)}</ul>
          )}
        </div>

        <div className="space-y-3 rounded-xl border border-border bg-card p-5">
          <SectionHeader title={latest ? (latest.kind === "INITIAL" ? "Latest import" : latest.kind === "INCREMENTAL" ? "Latest sync" : "Latest journey recalculation") : "Sync"} description={latest ? `${latest.status.toLowerCase()}${latest.startedAt ? ` · started ${formatDateTime(latest.startedAt, ctx.timezone)}` : ""}${latest.finishedAt ? ` · finished ${formatRelative(latest.finishedAt)}` : ""}` : "No sync has run yet."} />
          {latest ? <SyncStatus sync={toSyncData(latest)} /> : <EmptyState compact title="Not synced yet" description="Start the read-only import to bring in products, customers, subscriptions and order history." />}
        </div>
      </section>

      {webhooks ? (
        <section className="mb-6 space-y-3">
          <SectionHeader
            title="Webhooks"
            description="Low-latency signals from Recharge (order + subscription topics). Every delivery is HMAC-validated with the client secret, persisted immutably, then processed asynchronously: a targeted authoritative Recharge GET feeds the SAME import/recalculation code the sync uses, and the planner reconciles. The 4-hourly incremental sync stays on as the backstop."
            actions={hasRole(ctx, "ADMIN") ? <span className="inline-flex items-center gap-1"><WebhookSecretDialog integrationId={i.id} configured={webhooks.clientSecretConfigured} /><RegisterWebhooksControl integrationId={i.id} defaultBaseUrl={defaultBaseUrl} registered={!!webhooks.registration} secretConfigured={webhooks.clientSecretConfigured} /></span> : undefined}
          />
          <div className="grid gap-6 lg:grid-cols-2">
            <DetailList>
              <DetailRow label="Client secret">{webhooks.clientSecretConfigured ? <span className="text-status-success">configured and encrypted</span> : <span className="text-status-danger">missing, so deliveries cannot be validated</span>}</DetailRow>
              <DetailRow label="Endpoint"><span className="font-mono text-xs">{webhooks.registration ? webhooks.registration.endpoint : webhooks.endpointPath}</span></DetailRow>
              <DetailRow label="Registered">{webhooks.registration ? `${formatDateTime(new Date(webhooks.registration.registeredAt), ctx.timezone)} · base ${webhooks.registration.baseUrl}` : "not registered yet"}</DetailRow>
              <DetailRow label="Topics">
                <span className="flex flex-wrap gap-1">
                  {webhooks.expectedTopics.map((t) => {
                    const live = webhooks.registered?.some((w) => w.topic === t && (!webhooks.registration || w.address === webhooks.registration.endpoint));
                    return <span key={t} className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${live ? "bg-status-success-bg text-status-success" : "bg-muted text-muted-foreground"}`}>{t}{live ? " live" : ""}</span>;
                  })}
                </span>
              </DetailRow>
              {webhooks.registeredError ? <DetailRow label="Recharge /webhooks"><span className="text-status-warning">{webhooks.registeredError}</span></DetailRow> : null}
              <DetailRow label="Latest received">{webhooks.latestReceived ? `${webhooks.latestReceived.eventType} · ${formatRelative(webhooks.latestReceived.receivedAt)}${webhooks.latestReceived.signatureValid ? "" : " · INVALID SIGNATURE"}` : "none yet"}</DetailRow>
              <DetailRow label="Latest processed">{webhooks.latestProcessed?.processedAt ? `${webhooks.latestProcessed.eventType} · ${formatRelative(webhooks.latestProcessed.processedAt)}` : "none yet"}</DetailRow>
              <DetailRow label="Health · 24h"><span className="tnum">{webhooks.health.received24h} received · {webhooks.health.processed24h} processed · {webhooks.health.failed24h} failed · {webhooks.health.invalidSignature24h} invalid signature · {webhooks.health.pending} pending</span></DetailRow>
            </DetailList>
            <div className="overflow-x-auto rounded-xl border border-border bg-card">
              {webhookEvents.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">No deliveries yet. After registering, Recharge sends events as orders process and subscriptions change.</p>
              ) : (
                <Table>
                  <TableHeader><TableRow><TableHead>Topic</TableHead><TableHead>Resource</TableHead><TableHead>Status</TableHead><TableHead>Received</TableHead><TableHead>Attempts</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {webhookEvents.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="font-mono text-xs">{e.eventType}{e.signatureValid ? "" : <span className="ml-1 text-status-danger">bad signature</span>}</TableCell>
                        <TableCell className="font-mono text-xs">{e.externalEventId ?? "none"}</TableCell>
                        <TableCell className="text-xs">{e.status.toLowerCase()}{e.lastError && e.status === "FAILED" ? <span className="block max-w-56 truncate text-[11px] text-status-danger" title={e.lastError}>{e.lastError}</span> : null}</TableCell>
                        <TableCell className="text-xs">{formatRelative(e.receivedAt)}{e.processedAt ? ` · done ${formatRelative(e.processedAt)}` : ""}</TableCell>
                        <TableCell className="tnum text-xs">{e.attemptCount}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </div>
        </section>
      ) : null}

      {i.status !== "DISCONNECTED" ? (
        <section className="space-y-3">
          <SectionHeader
            title="Automation"
            description="The hard safety boundary for this store. When automation is off nothing is planned. In test mode gifts are planned and rehearsed against fresh data with a preview of the exact one-time, and nothing is written to Recharge. Live is not available yet."
            actions={hasRole(ctx, "ADMIN") ? <RunPlannerButton integrationId={i.id} disabled={i.automationMode === "OFF"} /> : undefined}
          />
          <AutomationModeControl integrationId={i.id} displayName={i.displayName} mode={i.automationMode} canManage={hasRole(ctx, "ADMIN")} />
          {plannerRuns.length > 0 ? (
            <div className="overflow-x-auto rounded-xl border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Planner run</TableHead>
                    <TableHead>Trigger</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead>Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plannerRuns.map((r) => {
                    const c = (r.countsJson ?? {}) as Record<string, number | string | null>;
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="tnum text-xs">{formatDateTime(r.startedAt, ctx.timezone)}</TableCell>
                        <TableCell className="text-xs">{r.trigger.toLowerCase()}</TableCell>
                        <TableCell className="text-xs">{r.automationMode}</TableCell>
                        <TableCell className="text-xs">{r.status !== "COMPLETED" ? `${r.status}${r.error ? `. ${r.error.slice(0, 80)}` : ""}` : c.skippedReason ? `skipped: ${String(c.skippedReason)}` : <span className="tnum">{c.subscriptionsEvaluated ?? 0} evaluated, {c.planned ?? 0} planned, {c.replanned ?? 0} replanned, {c.confirmed ?? 0} confirmed, {c.cancelled ?? 0} cancelled, {c.superseded ?? 0} superseded{Number(c.milestonesSkipped) > 0 ? `, ${c.milestonesSkipped} not plannable` : ""}</span>}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">The planner has not run for this store yet. It runs after every sync while dry run is on, or on demand.</p>
          )}
          <p className="text-xs text-muted-foreground">Planned actions and their dry-run previews live on <Link href={`/upcoming?integration=${i.id}`} className="underline">Upcoming</Link>.</p>
        </section>
      ) : null}

      <section className="space-y-3">
        <SectionHeader title="Cycle audit sample" description="Active subscriptions with the most history, for comparing against the order history in Recharge. The delivery count here must equal the number of successful orders for the subscription." />
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
                    <TableCell className="text-muted-foreground">{s.latestJourney?.program.name}{s.journeys.length > 1 ? <span className="ml-1 text-xs">(journey {s.journeys.length})</span> : null}</TableCell>
                    <TableCell className="tnum text-right font-semibold">{s.latestJourney?.successfulCycles ?? "none"}</TableCell>
                    <TableCell className="tnum text-right">{s.latestJourney?.cycles.length ?? 0}</TableCell>
                    <TableCell className="tnum text-right">{s.orders.length}</TableCell>
                    <TableCell className="max-w-xs">
                      <div className="flex flex-wrap gap-1">
                        {(s.latestJourney?.cycles ?? []).map((c) => (
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
                      <TableCell className="tnum text-xs text-muted-foreground">{dur === null ? "none" : dur < 60 ? `${dur}s` : `${Math.round(dur / 60)}m`}</TableCell>
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
            <DetailRow label="Store email">{settings?.store?.email ?? "none"}</DetailRow>
            <DetailRow label="Token scopes" mono>{settings?.scopes?.join(", ") ?? "not exposed"}</DetailRow>
            <DetailRow label="Integration id" mono>{i.id}</DetailRow>
          </DetailList>
        </div>
      </details>
    </>
  );
}

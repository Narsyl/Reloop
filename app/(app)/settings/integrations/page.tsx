import Link from "next/link";
import { Plug } from "lucide-react";
import { hasRole, requireOrg } from "@/lib/auth/tenancy";
import { listIntegrations } from "@/lib/domain/queries/settings";
import { getLatestSyncs } from "@/lib/domain/queries/integrations";
import { automationMode, integrationStatus } from "@/lib/status";
import { formatDateTime, formatRelative, pluralize } from "@/lib/format";
import { SectionHeader } from "@/components/layout/page-header";
import { StatusBadge } from "@/components/status/status-badge";
import { ConnectRechargeDialog } from "@/components/domain/connect-recharge-dialog";
import { ConnectShopifyDialog, RecheckShopifyButton } from "@/components/domain/connect-shopify-dialog";
import { ShopifyCapabilityPanel } from "@/components/domain/shopify-capability-panel";
import type { ShopifyCapabilityReport } from "@/lib/integrations/shopify";
import { IntegrationActions } from "@/components/domain/integration-actions";
import { SyncStatus, type SyncStatusData } from "@/components/domain/sync-status";
import type { CapabilityMap } from "@/lib/integrations/types";

export const metadata = { title: "Integrations" };

const REQUIRED: (keyof CapabilityMap)[] = ["store", "customers", "products", "orders", "subscriptions", "onetimes", "webhooks"];

export default async function IntegrationsPage() {
  const ctx = await requireOrg();
  const integrations = await listIntegrations(ctx);
  const latest = await getLatestSyncs(ctx, integrations.map((i) => i.id));
  const canManage = hasRole(ctx, "ADMIN");
  const canOperate = hasRole(ctx, "OPERATOR");
  const live = integrations.filter((i) => i.status !== "DISCONNECTED" && i.provider === "RECHARGE");
  const shopify = integrations.filter((i) => i.status !== "DISCONNECTED" && i.provider === "SHOPIFY");
  const disconnected = integrations.filter((i) => i.status === "DISCONNECTED");
  const rechargeOptions = live.map((i) => ({ id: i.id, displayName: i.displayName }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <SectionHeader title="Subscription platforms" description="Connect the platform that bills your subscribers. Imports are read-only; nothing is written to the platform until a rule is activated." />
        <div className="flex flex-wrap items-center gap-2">
          <ConnectRechargeDialog disabled={!canManage} />
          <ConnectShopifyDialog rechargeIntegrations={rechargeOptions} disabled={!canManage || rechargeOptions.length === 0} />
        </div>
      </div>

      {live.length === 0 && (
        <div className="flex items-start gap-4 rounded-xl border border-dashed border-border p-6">
          <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Plug className="size-5" /></div>
          <div className="space-y-1 text-sm">
            <div className="font-semibold">No platform connected yet</div>
            <p className="text-muted-foreground">
              Connect Recharge with a least-privilege API token: Customers, Products, Orders and Store information (view) plus Subscriptions (view + manage). Premium Recharge features (Events API, Credits, Storefront sessions) are not required.
            </p>
          </div>
        </div>
      )}

      {live.map((i) => {
        const caps = (i.capabilitiesJson as CapabilityMap | null) ?? null;
        const requiredOk = caps ? REQUIRED.every((k) => caps[k] !== "unavailable" && caps[k] !== "unknown") : false;
        const sync = latest.get(i.id);
        const syncData: SyncStatusData | null = sync
          ? { id: sync.id, kind: sync.kind, status: sync.status, stage: sync.stage, error: sync.error, progress: (sync.progressJson as SyncStatusData["progress"]) ?? {}, counts: (sync.countsJson as Record<string, number>) ?? {}, startedAt: sync.startedAt?.toISOString() ?? null, finishedAt: sync.finishedAt?.toISOString() ?? null }
          : null;
        const syncRunning = sync?.status === "QUEUED" || sync?.status === "RUNNING";
        return (
          <div key={i.id} className="rounded-xl border border-border bg-card">
            <div className="flex flex-wrap items-start justify-between gap-4 p-5">
              <div className="flex items-start gap-3">
                <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Plug className="size-5" /></div>
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/settings/integrations/${i.id}`} className="text-sm font-semibold hover:underline">{i.displayName}</Link>
                    <span className="text-xs text-muted-foreground">Recharge</span>
                    <StatusBadge status={integrationStatus[i.status]} />
                    <StatusBadge status={automationMode[i.automationMode]} />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {i.externalStoreId} · {i.lastSuccessfulSyncAt ? `last synced ${formatRelative(i.lastSuccessfulSyncAt)}` : "not synced yet"} · {pluralize(i._count.subscriptions, "subscription")}, {pluralize(i._count.products, "product")}, {pluralize(i._count.customers, "customer")}
                  </div>
                  <div className={`text-xs font-medium ${requiredOk ? "text-status-success" : "text-status-danger"}`}>
                    {requiredOk ? "Everything Reloop needs is available." : "Some required capabilities are missing."}
                    {i.capabilitiesCheckedAt && <span className="font-normal text-muted-foreground"> Checked {formatRelative(i.capabilitiesCheckedAt)}.</span>}
                  </div>
                  {i.lastErrorMessage && <div className="text-xs text-status-danger">Last error: {i.lastErrorMessage} ({formatDateTime(i.lastErrorAt, ctx.timezone)})</div>}
                </div>
              </div>
              <IntegrationActions integrationId={i.id} displayName={i.displayName} canManage={canManage} canOperate={canOperate} syncRunning={!!syncRunning} hasSynced={!!i.lastSuccessfulSyncAt} />
            </div>
            {syncData && (
              <div className="border-t border-border px-5 py-4">
                <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{syncData.kind === "INITIAL" ? "Initial import" : syncData.kind === "INCREMENTAL" ? "Sync" : "Journey recalculation"} · {syncData.status.toLowerCase()}{sync?.startedAt ? ` · started ${formatRelative(sync.startedAt)}` : ""}</span>
                  <Link href={`/settings/integrations/${i.id}`} className="font-medium text-primary hover:underline">Details & history</Link>
                </div>
                <SyncStatus sync={syncData} compact />
              </div>
            )}
          </div>
        );
      })}

      <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <SectionHeader title="Catalogue (Shopify)" description="Shopify is used only to discover, create and verify the fulfilment-marker products that one-times will reference. It never reads orders or customers and never edits orders; Recharge stays the subscription authority." />
      </div>
      {shopify.length === 0 ? (
        <p className="text-xs text-muted-foreground">No Shopify store connected. Connect one with a custom app limited to products + publications to generate the fulfilment markers.</p>
      ) : null}
      {shopify.map((i) => {
        const report = (i.capabilitiesJson as ShopifyCapabilityReport | null) ?? null;
        const settings = (i.settingsJson as { shopDomain?: string; store?: { name?: string } } | null) ?? null;
        const paired = integrations.find((x) => x.id === i.pairedIntegrationId);
        return (
          <div key={i.id} className="rounded-xl border border-border bg-card">
            <div className="flex flex-wrap items-start justify-between gap-4 p-5">
              <div className="flex items-start gap-3">
                <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Plug className="size-5" /></div>
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/settings/integrations/${i.id}`} className="text-sm font-semibold hover:underline">{i.displayName}</Link>
                    <span className="text-xs text-muted-foreground">Shopify, catalogue only</span>
                    <StatusBadge status={integrationStatus[i.status]} />
                  </div>
                  <div className="text-xs text-muted-foreground">{settings?.shopDomain ?? i.externalStoreId} · serves {paired ? paired.displayName : "no Recharge store (pair it)"}, {pluralize(i._count.rewardBindings, "gift")} verified here{i.capabilitiesCheckedAt ? ` · checked ${formatRelative(i.capabilitiesCheckedAt)}` : ""}</div>
                  {i.lastErrorMessage && <div className="text-xs text-status-danger">Last error: {i.lastErrorMessage} ({formatDateTime(i.lastErrorAt, ctx.timezone)})</div>}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {canManage ? <RecheckShopifyButton integrationId={i.id} /> : null}
                {canManage ? <ConnectShopifyDialog rechargeIntegrations={rechargeOptions} existing={{ shopDomain: settings?.shopDomain ?? i.externalStoreId, pairedIntegrationId: i.pairedIntegrationId }} /> : null}
              </div>
            </div>
            {report ? <div className="border-t border-border px-5 py-4"><ShopifyCapabilityPanel report={report} /></div> : null}
          </div>
        );
      })}

      {disconnected.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Disconnected</h3>
          {disconnected.map((i) => (
            <div key={i.id} className="flex items-center justify-between rounded-xl border border-border px-4 py-3 text-sm">
              <div>
                <Link href={`/settings/integrations/${i.id}`} className="font-medium hover:underline">{i.displayName}</Link>
                <span className="ml-2 text-xs text-muted-foreground">{i.externalStoreId} · data retained</span>
              </div>
              <StatusBadge status={integrationStatus.DISCONNECTED} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

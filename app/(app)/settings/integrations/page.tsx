import { Plug } from "lucide-react";
import { hasRole, requireOrg } from "@/lib/auth/tenancy";
import { listIntegrations } from "@/lib/domain/queries/settings";
import { automationMode, integrationStatus } from "@/lib/status";
import { formatDateTime, formatRelative, pluralize } from "@/lib/format";
import { SectionHeader } from "@/components/layout/page-header";
import { StatusBadge } from "@/components/status/status-badge";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Integrations" };

type Capabilities = Record<string, "available" | "read_write" | "read" | "unavailable" | string>;

const REQUIRED: { key: string; label: string }[] = [
  { key: "customers", label: "Customers" },
  { key: "products", label: "Products" },
  { key: "orders", label: "Orders" },
  { key: "subscriptions", label: "Subscriptions" },
  { key: "onetimes", label: "One-times" },
  { key: "webhooks", label: "Webhooks" },
];
const OPTIONAL: { key: string; label: string }[] = [
  { key: "charges", label: "Charges (verification)" },
  { key: "credits", label: "Credits" },
  { key: "events", label: "Events API" },
  { key: "customer_sessions", label: "Storefront sessions" },
];

function capLabel(v: string | undefined) {
  if (!v || v === "unavailable") return "unavailable on current plan";
  if (v === "read_write") return "read / write";
  return v.replace(/_/g, " ");
}

export default async function IntegrationsPage() {
  const ctx = await requireOrg();
  const integrations = await listIntegrations(ctx);
  const canManage = hasRole(ctx, "ADMIN");
  const recharge = integrations.find((i) => i.provider === "RECHARGE");

  return (
    <div className="space-y-6">
      <SectionHeader title="Subscription platforms" description="Connect the platform that bills your subscribers. The platform is read read-only until you activate a rule." />

      <div className="rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-start justify-between gap-4 p-5">
          <div className="flex items-start gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Plug className="size-5" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold">Recharge</h3>
                <StatusBadge status={recharge ? integrationStatus[recharge.status] : integrationStatus.DISCONNECTED} />
                {recharge && <StatusBadge status={automationMode[recharge.automationMode]} />}
              </div>
              {recharge ? (
                <div className="text-xs text-muted-foreground">
                  {recharge.displayName} · store {recharge.externalStoreId} ·{" "}
                  {recharge.lastSuccessfulSyncAt ? `last synced ${formatRelative(recharge.lastSuccessfulSyncAt)}` : "not synced yet"} ·{" "}
                  {pluralize(recharge._count.subscriptions, "subscription")}, {pluralize(recharge._count.products, "product")}
                  {recharge.lastErrorMessage && <span className="block text-status-danger">Last error: {recharge.lastErrorMessage} ({formatDateTime(recharge.lastErrorAt, ctx.timezone)})</span>}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Uses the Recharge Admin API with a least-privilege token: Customers, Products, Orders and Store information (view) plus Subscriptions (view + manage). No premium Recharge features are required.
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {recharge ? (
              <>
                <Button variant="outline" size="sm" disabled title="Available in Phase 2">Sync</Button>
                <Button variant="outline" size="sm" disabled title="Available in Phase 2">Settings</Button>
                <Button variant="destructive" size="sm" disabled title="Available in Phase 2">Disconnect</Button>
              </>
            ) : (
              <Button disabled={!canManage} title="The connection flow arrives in Phase 2">Connect Recharge</Button>
            )}
          </div>
        </div>

        {recharge && (
          <div className="grid gap-6 border-t border-border p-5 sm:grid-cols-2">
            <div className="space-y-2">
              <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Required capabilities</h4>
              <ul className="space-y-1 text-sm">
                {REQUIRED.map((c) => {
                  const v = (recharge.capabilitiesJson as Capabilities | null)?.[c.key];
                  const ok = v && v !== "unavailable";
                  return (
                    <li key={c.key} className="flex items-center justify-between gap-3">
                      <span className="flex items-center gap-2">
                        <span className={`size-2 rounded-full ${ok ? "bg-status-success" : "bg-status-danger"}`} />
                        {c.label}
                      </span>
                      <span className="text-xs text-muted-foreground">{capLabel(v)}</span>
                    </li>
                  );
                })}
              </ul>
              <p className="pt-1 text-xs text-muted-foreground">
                {REQUIRED.every((c) => {
                  const v = (recharge.capabilitiesJson as Capabilities | null)?.[c.key];
                  return v && v !== "unavailable";
                })
                  ? "All features required by Subscription Ops are available."
                  : "Some required capabilities are missing — rules cannot be activated until they are granted."}
                {recharge.capabilitiesCheckedAt && ` Checked ${formatRelative(recharge.capabilitiesCheckedAt)}.`}
              </p>
            </div>
            <div className="space-y-2">
              <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Optional Recharge features</h4>
              <ul className="space-y-1 text-sm">
                {OPTIONAL.map((c) => {
                  const v = (recharge.capabilitiesJson as Capabilities | null)?.[c.key];
                  const ok = v && v !== "unavailable";
                  return (
                    <li key={c.key} className="flex items-center justify-between gap-3 text-muted-foreground">
                      <span className="flex items-center gap-2">
                        <span className={`size-2 rounded-full ${ok ? "bg-status-success" : "bg-border"}`} />
                        {c.label}
                      </span>
                      <span className="text-xs">{capLabel(v)}</span>
                    </li>
                  );
                })}
              </ul>
              <p className="pt-1 text-xs text-muted-foreground">Not needed. The platform never depends on premium Recharge resources.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

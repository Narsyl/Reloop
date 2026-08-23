"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Store, ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ShopifyCapabilityReport } from "@/lib/integrations/shopify";
import { connectShopify, recheckShopifyCapabilities, testShopifyConnection } from "@/lib/domain/integrations/shopify-actions";
import { ShopifyCapabilityPanel } from "@/components/domain/shopify-capability-panel";

const selectCls = "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function ConnectShopifyDialog({ rechargeIntegrations, disabled, existing }: { rechargeIntegrations: { id: string; displayName: string }[]; disabled?: boolean; existing?: { shopDomain: string; pairedIntegrationId: string | null } | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [shopDomain, setShopDomain] = useState(existing?.shopDomain ?? "");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [paired, setPaired] = useState(existing?.pairedIntegrationId ?? rechargeIntegrations[0]?.id ?? "");
  const [report, setReport] = useState<ShopifyCapabilityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, startTest] = useTransition();
  const [saving, startSave] = useTransition();

  function test() {
    setError(null);
    setReport(null);
    startTest(async () => {
      const r = await testShopifyConnection({ shopDomain, clientId, clientSecret });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setReport(r.data!);
    });
  }
  function connect() {
    setError(null);
    startSave(async () => {
      const r = await connectShopify({ shopDomain, clientId, clientSecret, pairedIntegrationId: paired || null });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.success(`Shopify connected — ${r.data!.report.store.name}`);
      setOpen(false);
      setClientSecret("");
      router.refresh();
    });
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setReport(null); setError(null); setClientSecret(""); } }}>
      <DialogTrigger render={<span className="contents" />}><Button variant="outline" disabled={disabled}><Store data-icon="inline-start" /> {existing ? "Reconnect Shopify" : "Connect Shopify"}</Button></DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{existing ? "Reconnect Shopify" : "Connect Shopify (read-only catalogue)"}</DialogTitle>
          <DialogDescription>
            From the Shopify Dev Dashboard app (Settings): paste the <span className="font-medium">Client ID</span> and <span className="font-medium">Client secret</span>. We exchange them server-side for a short-lived Admin API token (refreshed automatically) and only ever read products — used to bind Whisk / Cup / Spoon to their existing variants. Required scope: <span className="font-mono">read_products</span> (<span className="font-mono">read_publications</span> optional). No writes, no orders, no customers.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="shp-domain">myshopify.com domain</Label>
              <Input id="shp-domain" value={shopDomain} onChange={(e) => setShopDomain(e.target.value)} placeholder="your-store.myshopify.com" className="font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="shp-pair">Serves Recharge store</Label>
              <select id="shp-pair" className={selectCls} value={paired} onChange={(e) => setPaired(e.target.value)}>
                {rechargeIntegrations.length === 0 ? <option value="">— no Recharge integration yet —</option> : null}
                {rechargeIntegrations.map((i) => <option key={i.id} value={i.id}>{i.displayName}</option>)}
              </select>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="shp-client-id">Client ID</Label>
              <Input id="shp-client-id" value={clientId} onChange={(e) => setClientId(e.target.value)} className="font-mono" autoComplete="off" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="shp-client-secret">Client secret</Label>
              <Input id="shp-client-secret" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} className="font-mono" autoComplete="off" />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">Encrypted per integration; the secret is never shown again, never logged and never sent to the browser after saving. Test first — nothing is saved until you connect.</p>
          {error ? <p className="rounded-lg border border-status-danger/30 bg-status-danger-bg px-3 py-2 text-xs text-status-danger">{error}</p> : null}
          {report ? (
            <div className="rounded-lg border border-border p-3">
              <div className="mb-2 text-sm"><span className="font-semibold">{report.store.name}</span> · <span className="font-mono text-xs">{report.store.myshopifyDomain}</span> · {report.store.currencyCode}{report.store.planDisplayName ? ` · ${report.store.planDisplayName}` : ""}{report.tokenExpiresAt ? <span className="text-xs text-muted-foreground"> · token ok (auto-refresh)</span> : null}</div>
              <ShopifyCapabilityPanel report={report} />
              <p className={`mt-2 text-xs font-medium ${report.requiredOk ? "text-status-success" : "text-status-danger"}`}>{report.requiredOk ? "Ready to connect." : "Not usable yet — grant read_products to the app, reinstall it and test again."}</p>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          <Button variant="outline" onClick={test} disabled={testing || !shopDomain || !clientId || !clientSecret}><ShieldCheck data-icon="inline-start" /> {testing ? "Testing…" : "Test connection"}</Button>
          <Button onClick={connect} disabled={saving || !report?.requiredOk || !paired}>{saving ? "Connecting…" : existing ? "Reconnect" : "Connect"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RecheckShopifyButton({ integrationId }: { integrationId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => {
      const r = await recheckShopifyCapabilities(integrationId);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("Shopify capabilities re-checked");
      router.refresh();
    })}><ShieldCheck data-icon="inline-start" /> {pending ? "Checking…" : "Re-check capabilities"}</Button>
  );
}

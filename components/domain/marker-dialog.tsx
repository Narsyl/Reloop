"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Plus, Search } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { discoverMarkersFromOnetimes, saveMarker, setMarkerActive, type DiscoveredMarker } from "@/lib/domain/markers/actions";
import { ConfirmationDialog } from "@/components/domain/confirmation-dialog";
import { cn } from "@/lib/utils";

export type MarkerFormInitial = {
  id?: string;
  integrationId: string;
  name: string;
  description: string;
  externalVariantId: string;
  externalProductId: string;
  title: string;
  sku: string;
  source: "MANUAL" | "CATALOGUE" | "DISCOVERED_ONETIME";
  placeholder?: boolean;
};

export function MarkerDialog({ integrations, initial, trigger }: { integrations: { id: string; displayName: string }[]; initial?: MarkerFormInitial; trigger?: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<MarkerFormInitial>(initial ?? { integrationId: integrations[0]?.id ?? "", name: "", description: "", externalVariantId: "", externalProductId: "", title: "", sku: "", source: "MANUAL", placeholder: false });
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [discovered, setDiscovered] = useState<DiscoveredMarker[] | null>(null);
  const [discovering, startDiscover] = useTransition();
  const [saving, startSave] = useTransition();

  function discover() {
    startDiscover(async () => {
      const res = await discoverMarkersFromOnetimes(form.integrationId);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setDiscovered(res.data!);
      if (res.data!.length === 0) toast.message("No one-times found in the store");
    });
  }
  function applyDiscovered(d: DiscoveredMarker) {
    setForm((f) => ({ ...f, externalVariantId: d.externalVariantId, externalProductId: d.externalProductId ?? "", title: d.title ?? f.title, sku: d.sku ?? f.sku, name: f.name || (d.title ? `${d.title} marker` : f.name), source: "DISCOVERED_ONETIME" }));
  }
  function submit() {
    setErrors({});
    startSave(async () => {
      const res = await saveMarker(form);
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
        return;
      }
      toast.success(initial?.id ? "Marker updated" : "Marker saved — nothing was written to the subscription platform");
      setOpen(false);
      router.refresh();
    });
  }
  const err = (k: string) => errors[k]?.[0];
  const selectCls = "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<span className="contents" />}>{trigger ?? <Button><Plus data-icon="inline-start" /> New marker</Button>}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial?.id ? "Edit fulfilment marker" : "New fulfilment marker"}</DialogTitle>
          <DialogDescription>
            The £0 item that tells fulfilment what to include. The external variant id is what gets inserted into a shipment; title and SKU are for humans. Saving here writes nothing to your subscription platform.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="mk-int">Store / integration</Label>
            <select id="mk-int" className={selectCls} value={form.integrationId} onChange={(e) => setForm({ ...form, integrationId: e.target.value })} disabled={!!initial?.id}>
              {integrations.map((i) => (
                <option key={i.id} value={i.id}>{i.displayName}</option>
              ))}
            </select>
          </div>

          <div className="rounded-lg border border-dashed border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Discover from existing one-times</div>
              <Button size="xs" variant="outline" onClick={discover} disabled={discovering || !form.integrationId}>
                <Search data-icon="inline-start" /> {discovering ? "Reading…" : "Read store one-times"}
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Read-only: lists variants already used as one-time items in the store (e.g. your manual test marker) so you can pre-fill — you still review and save explicitly.</p>
            {discovered && discovered.length > 0 && (
              <ul className="mt-2 divide-y divide-border rounded-md border border-border">
                {discovered.map((d) => (
                  <li key={d.externalVariantId} className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs">
                    <span className="min-w-0">
                      <span className="font-medium">{d.title ?? "Untitled item"}</span>
                      {d.sku && <span className="ml-1 font-mono text-muted-foreground">{d.sku}</span>}
                      <span className="block font-mono text-[11px] text-muted-foreground">variant {d.externalVariantId}{d.externalProductId ? ` · product ${d.externalProductId}` : ""} · seen {d.occurrences}× · last {d.lastSeen ?? "—"}{d.price ? ` · £${d.price}` : ""}</span>
                    </span>
                    {d.alreadyConfigured ? <span className="shrink-0 text-muted-foreground">already a marker</span> : <Button size="xs" variant="ghost" onClick={() => applyDiscovered(d)}>Use</Button>}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="mk-name">Internal name</Label>
              <Input id="mk-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Morning Magic Cycle 2" />
              {err("name") && <p className="text-xs text-status-danger">{err("name")}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mk-title">Item title (as fulfilment sees it)</Label>
              <Input id="mk-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Morning Magic 2" />
              {err("title") && <p className="text-xs text-status-danger">{err("title")}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mk-sku">SKU <span className="text-muted-foreground">(verification only)</span></Label>
              <Input id="mk-sku" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} placeholder="MM-CYCLE-02" className="font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mk-var">External variant id <span className="text-status-danger">*</span></Label>
              <Input id="mk-var" value={form.externalVariantId} onChange={(e) => setForm({ ...form, externalVariantId: e.target.value })} placeholder="49382910591234" className="font-mono" />
              {err("externalVariantId") && <p className="text-xs text-status-danger">{err("externalVariantId")}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mk-prod">External product id <span className="text-muted-foreground">(optional)</span></Label>
              <Input id="mk-prod" value={form.externalProductId} onChange={(e) => setForm({ ...form, externalProductId: e.target.value })} className="font-mono" />
              {err("externalProductId") && <p className="text-xs text-status-danger">{err("externalProductId")}</p>}
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="mk-desc">Operational note <span className="text-muted-foreground">(internal)</span></Label>
              <Textarea id="mk-desc" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Fulfilment team adds the free whisk." />
            </div>
            <label className="flex items-start gap-2 rounded-lg border border-dashed border-border p-3 text-xs sm:col-span-2">
              <input type="checkbox" className="mt-0.5" checked={!!form.placeholder} onChange={(e) => setForm({ ...form, placeholder: e.target.checked })} />
              <span>
                <span className="block font-medium">Placeholder — configuration only, never executable</span>
                <span className="text-muted-foreground">Use while the real £0 fulfilment item does not exist yet. Rules pointing at a placeholder cannot be marked Ready and the planner never creates actions for them.</span>
              </span>
            </label>
          </div>
          <p className={cn("text-xs", form.source === "DISCOVERED_ONETIME" ? "text-status-info" : "text-muted-foreground")}>
            {form.source === "DISCOVERED_ONETIME" ? "Pre-filled from an existing one-time. Discovery proves the variant was used before; it does not guarantee it still exists — confirm in Shopify." : "Paste the numeric Shopify variant id (not a GID). On Shopify-checkout stores it cannot be verified through Recharge until the first live write."}
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving || !form.integrationId || !form.name || !form.externalVariantId || !form.title}>{saving ? "Saving…" : initial?.id ? "Save changes" : "Save marker"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MarkerActiveToggle({ id, name, active, usedByRules }: { id: string; name: string; active: boolean; usedByRules: number }) {
  const router = useRouter();
  return (
    <ConfirmationDialog
      trigger={<Button size="xs" variant="ghost">{active ? "Deactivate" : "Reactivate"}</Button>}
      title={active ? `Deactivate “${name}”?` : `Reactivate “${name}”?`}
      impact={active ? (usedByRules > 0 ? `This marker is used by ${usedByRules} ready rule(s); deactivation will be refused until they are disabled or archived.` : "Inactive markers cannot be chosen by new rules. Existing history is kept.") : "The marker becomes available to rules again."}
      confirmLabel={active ? "Deactivate" : "Reactivate"}
      destructive={active}
      onConfirm={async () => {
        const r = await setMarkerActive({ id, active: !active });
        if (r.ok) router.refresh();
        return r;
      }}
    />
  );
}

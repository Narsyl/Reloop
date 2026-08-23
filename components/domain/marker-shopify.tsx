"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Search, ShieldCheck, Store } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { MissingMarkerRow, ExistingCandidate, MarkerIssue } from "@/lib/domain/markers/shopify";
import { adoptMarkerFromShopify, checkExistingMarker, createMarkerFromShopify, saveProgramMarkerNaming, verifyMarker } from "@/lib/domain/markers/shopify-actions";

type PreviewRow = MissingMarkerRow & { title: string; sku: string; checking?: boolean; candidates?: ExistingCandidate[]; result?: { ok: boolean; message: string }; acknowledged?: boolean };

function candidateLabel(c: ExistingCandidate): string {
  if (c.product) {
    const v = c.product.variants[0];
    return `${c.matchedBy}: Shopify "${c.product.title}" (product ${c.product.productId}${v ? `, variant ${v.variantId}, SKU ${v.sku ?? "—"}, £${v.price}` : ""}, ${c.product.status}${c.product.publishedOnlineStore === false ? ", not on Online Store" : ""})`;
  }
  if (c.internalMarker) return `${c.matchedBy}: existing marker "${c.internalMarker.name}" (variant ${c.internalMarker.externalVariantId}${c.internalMarker.placeholder ? ", placeholder" : ""})`;
  return c.matchedBy;
}

/**
 * "Missing fulfilment markers" — every (programme × renewal milestone) without a real marker. Generate
 * opens an explicit preview (title, SKU, reward, price, Shopify state, publication, programme, milestone),
 * runs duplicate detection, and creates nothing until the operator confirms each row (or all).
 */
export function MissingMarkersPanel({ rows, canManage, shopifyConnected }: { rows: MissingMarkerRow[]; canManage: boolean; shopifyConnected: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [busy, startBusy] = useTransition();

  function openPreview(selection: MissingMarkerRow[]) {
    setPreview(selection.map((r) => ({ ...r, title: r.proposedTitle, sku: r.proposedSku })));
    setOpen(true);
  }
  function update(i: number, patch: Partial<PreviewRow>) {
    setPreview((p) => p.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function runChecks() {
    startBusy(async () => {
      for (let i = 0; i < preview.length; i++) {
        const r = preview[i];
        if (!r.shopifyIntegrationId) { update(i, { result: { ok: false, message: "No Shopify store paired with this programme's store" } }); continue; }
        update(i, { checking: true });
        const res = await checkExistingMarker({ shopifyIntegrationId: r.shopifyIntegrationId, rechargeIntegrationId: r.rechargeIntegrationId, sku: r.sku, title: r.title });
        update(i, { checking: false, candidates: res.ok ? res.data!.filter((c) => !(c.matchedBy === "INTERNAL_MARKER" && c.internalMarker?.id === r.placeholderMarkerId)) : undefined, result: res.ok ? undefined : { ok: false, message: res.error } });
      }
    });
  }
  function createOne(i: number) {
    const r = preview[i];
    startBusy(async () => {
      const res = await createMarkerFromShopify({ programId: r.programId, milestoneId: r.milestoneId, title: r.title, sku: r.sku, replaceMarkerId: r.placeholderMarkerId, acknowledgeCandidates: !!r.acknowledged });
      if (!res.ok) {
        update(i, { result: { ok: false, message: res.error }, candidates: res.candidates ?? r.candidates });
        toast.error(res.error);
        return;
      }
      update(i, { result: { ok: true, message: `Created — product ${res.data!.productId}, variant ${res.data!.variantId}, ${res.data!.product.status}, Online Store ${res.data!.product.publishedOnlineStore ? "published" : "not published"}` } });
      toast.success(`Created "${r.title}" in Shopify and bound it`);
      router.refresh();
    });
  }
  function adoptOne(i: number, variantId: string) {
    const r = preview[i];
    startBusy(async () => {
      const res = await adoptMarkerFromShopify({ programId: r.programId, milestoneId: r.milestoneId, variantId, name: r.title, replaceMarkerId: r.placeholderMarkerId });
      if (!res.ok) { update(i, { result: { ok: false, message: res.error } }); toast.error(res.error); return; }
      update(i, { result: { ok: true, message: `Adopted variant ${variantId} ("${res.data!.product.title}")` } });
      toast.success(`Adopted existing Shopify variant for "${r.title}"`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">{rows.length === 0 ? "Every renewal milestone has a real marker bound." : `${rows.length} marker${rows.length === 1 ? "" : "s"} missing (or still a placeholder).`}{!shopifyConnected ? " Connect Shopify (Settings → Integrations) to create or adopt them." : ""}</div>
        {canManage && rows.length > 0 ? <Button size="sm" onClick={() => openPreview(rows)} disabled={!shopifyConnected}><Store data-icon="inline-start" /> Generate markers…</Button> : null}
      </div>
      {rows.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground"><tr className="border-b border-border"><th className="px-3 py-2 font-medium">Marker</th><th className="px-3 py-2 font-medium">Reward</th><th className="px-3 py-2 font-medium">Programme · milestone</th><th className="px-3 py-2 font-medium">Proposed SKU</th><th className="px-3 py-2 font-medium">Shopify</th><th className="px-3 py-2" /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.milestoneId + r.programId} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 font-medium">{r.proposedTitle}</td>
                  <td className="px-3 py-2">{r.rewardItemName}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{r.programName} · {r.scheduleName.split(" — ")[0]} delivery {r.cycleNumber}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.proposedSku}</td>
                  <td className="px-3 py-2 text-xs">{r.placeholderMarkerId ? <span className="text-status-warning">Placeholder — replace</span> : <span className="text-muted-foreground">Missing</span>}</td>
                  <td className="px-3 py-2 text-right">{canManage ? <span className="inline-flex items-center gap-1"><ProgramNamingDialog programId={r.programId} programName={r.programName} markerLabel={r.markerLabel} skuPrefix={r.skuPrefix} /><Button size="xs" variant="outline" onClick={() => openPreview([r])} disabled={!shopifyConnected}>Preview & create</Button></span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Generate fulfilment markers — preview</DialogTitle>
            <DialogDescription>Nothing is created until you confirm a row. Every marker is created as price 0.00 · status UNLISTED (usable by apps, hidden from storefront discovery) · published to the Online Store · inventory untracked · type &ldquo;Fulfillment Marker&rdquo; · tag subscription-ops-marker. Recharge compatibility stays UNVERIFIED until the controlled Recharge test.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={runChecks} disabled={busy || preview.length === 0}><Search data-icon="inline-start" /> {busy ? "Checking…" : "Check Shopify for existing products"}</Button>
            <span className="text-xs text-muted-foreground">Duplicate detection: stored variant id, exact SKU, exact title, internal markers.</span>
          </div>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground"><tr className="border-b border-border"><th className="px-2 py-2 font-medium">Title</th><th className="px-2 py-2 font-medium">SKU</th><th className="px-2 py-2 font-medium">Reward</th><th className="px-2 py-2 font-medium">Programme · milestone</th><th className="px-2 py-2 font-medium">Shopify state</th><th className="px-2 py-2 font-medium">Duplicates / result</th><th className="px-2 py-2" /></tr></thead>
              <tbody>
                {preview.map((r, i) => (
                  <tr key={r.milestoneId + r.programId} className="border-b border-border align-top last:border-0">
                    <td className="px-2 py-2"><Input value={r.title} onChange={(e) => update(i, { title: e.target.value, candidates: undefined })} className="h-8 min-w-40" /></td>
                    <td className="px-2 py-2"><Input value={r.sku} onChange={(e) => update(i, { sku: e.target.value.toUpperCase(), candidates: undefined })} className="h-8 min-w-40 font-mono" /></td>
                    <td className="px-2 py-2 text-xs">{r.rewardItemName}<span className="block text-[11px] text-muted-foreground">{r.rewardOperational ?? ""}</span></td>
                    <td className="px-2 py-2 text-xs">{r.programName}<span className="block text-[11px] text-muted-foreground">{r.scheduleName.split(" — ")[0]} · delivery {r.cycleNumber}{r.placeholderMarkerId ? ` · replaces placeholder "${r.placeholderMarkerName}"` : ""}</span></td>
                    <td className="px-2 py-2 text-[11px] text-muted-foreground">0.00 · UNLISTED · Online Store published · untracked</td>
                    <td className="px-2 py-2 text-xs">
                      {r.checking ? "checking…" : null}
                      {r.candidates && r.candidates.length === 0 ? <span className="text-status-success">no existing product found</span> : null}
                      {r.candidates && r.candidates.length > 0 ? (
                        <div className="space-y-1">
                          <div className="font-medium text-status-warning">POSSIBLE_EXISTING_MARKER</div>
                          {r.candidates.map((c, j) => (
                            <div key={j} className="flex flex-wrap items-center gap-1">
                              <span>{candidateLabel(c)}</span>
                              {c.product?.variants[0] && canManage ? <Button size="xs" variant="ghost" disabled={busy} onClick={() => adoptOne(i, c.product!.variants[0].variantId)}>Adopt this</Button> : null}
                            </div>
                          ))}
                          <label className="flex items-center gap-1 text-[11px]"><input type="checkbox" checked={!!r.acknowledged} onChange={(e) => update(i, { acknowledged: e.target.checked })} /> I inspected these; create a new product anyway</label>
                        </div>
                      ) : null}
                      {r.result ? <div className={r.result.ok ? "text-status-success" : "text-status-danger"}>{r.result.message}</div> : null}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {canManage && !r.result?.ok ? <Button size="xs" disabled={busy || !r.title || !r.sku || (r.candidates === undefined && !r.acknowledged) || (!!r.candidates?.length && !r.acknowledged)} onClick={() => createOne(i)} title={r.candidates === undefined ? "Run the duplicate check first" : undefined}>Create</Button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ProgramNamingDialog({ programId, programName, markerLabel, skuPrefix }: { programId: string; programName: string; markerLabel: string; skuPrefix: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(markerLabel);
  const [prefix, setPrefix] = useState(skuPrefix);
  const [saving, start] = useTransition();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<span className="contents" />}><Button size="xs" variant="ghost">Naming</Button></DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Marker naming — {programName}</DialogTitle><DialogDescription>Warehouse convention: &ldquo;&lt;label&gt; &lt;delivery&gt;&rdquo; (e.g. &ldquo;Morning Magic 2&rdquo;) and SKU &ldquo;&lt;prefix&gt;-CYCLE-NN&rdquo;.</DialogDescription></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label>Marker label</Label><Input value={label} onChange={(e) => setLabel(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>SKU prefix</Label><Input value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} className="font-mono" /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={saving} onClick={() => start(async () => { const r = await saveProgramMarkerNaming({ programId, markerLabel: label, skuPrefix: prefix }); if (!r.ok) { toast.error(r.error); return; } toast.success("Naming saved"); setOpen(false); router.refresh(); })}>{saving ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function VerifyMarkerButton({ markerId, size = "xs" }: { markerId: string; size?: "xs" | "sm" }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button size={size} variant="ghost" disabled={pending} onClick={() => start(async () => {
      const r = await verifyMarker(markerId);
      if (!r.ok) { toast.error(r.error); return; }
      const issues = r.data!.issues as MarkerIssue[];
      if (issues.length === 0) toast.success("Verified in Shopify — no issues");
      else toast.message(`Verified — issues: ${issues.join(", ")}`);
      router.refresh();
    })}><ShieldCheck data-icon="inline-start" /> {pending ? "Verifying…" : "Verify in Shopify"}</Button>
  );
}

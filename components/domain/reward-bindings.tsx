"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Link2, Search, ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { RewardBindingRow } from "@/lib/domain/rewards/bindings";
import type { ShopifyProductSummary } from "@/lib/integrations/shopify";
import { bindRewardToShopifyVariant, searchShopifyCatalog, unbindReward, verifyRewardBindingNow } from "@/lib/domain/rewards/actions";

const ISSUE_HINT: Record<string, string> = {
  MISSING_IN_SHOPIFY: "the variant is missing in Shopify",
  DRAFT_OR_ARCHIVED: "the product is draft or archived",
  NOT_REQUIRING_SHIPPING: "it does not require shipping",
  INVENTORY_TRACKED: "inventory is tracked",
  NOT_PUBLISHED_ONLINE_STORE: "not published on the Online Store",
  PRICED: "the product has a price, the gift will still be £0.00",
};

function StatusCell({ row }: { row: RewardBindingRow }) {
  switch (row.status) {
    case "NO_SHOPIFY":
      return <span className="text-xs text-muted-foreground">Connect Shopify first</span>;
    case "NEEDS_BINDING":
      return <span className="text-xs font-medium text-status-warning">Choose a product</span>;
    case "INACTIVE":
      return <span className="text-xs font-medium text-status-warning">Not linked. Link it again to plan gifts.</span>;
    case "BLOCKED":
      return <span className="text-xs font-medium text-status-danger">Blocked: {row.binding?.issues.filter((i) => i === "MISSING_IN_SHOPIFY" || i === "DRAFT_OR_ARCHIVED").map((i) => ISSUE_HINT[i] ?? i).join(", ")}</span>;
    default:
      return (
        <span className="text-xs font-medium text-status-success">
          Verified in Shopify
          {row.binding?.issues.length ? <span className="block font-normal text-muted-foreground">{row.binding.issues.map((i) => ISSUE_HINT[i] ?? i).join(", ")}</span> : null}
        </span>
      );
  }
}

/**
 * "Reward fulfilment products": each physical reward item (Whisk, Cup, Spoon…) and its Shopify
 * binding. Binding searches the store READ-ONLY, the operator picks the existing product/variant,
 * and only the canonical ids + a verified snapshot are stored. Nothing is created in Shopify.
 */
export function RewardBindingsTable({ rows, canManage }: { rows: RewardBindingRow[]; canManage: boolean }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No gifts yet. Create them under Gift items first, for example the Whisk, the Cup and the Spoon.</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr className="border-b border-border">
            <th className="px-3 py-2 font-medium">Gift</th>
            <th className="px-3 py-2 font-medium">Shopify product</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Used by</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.rewardItem.id + (r.shopify?.id ?? "-")} className="border-b border-border align-top last:border-0">
              <td className="px-3 py-2">
                <span className="font-medium">{r.rewardItem.name}</span>
                {!r.rewardItem.active ? <span className="ml-1 text-[11px] text-muted-foreground">inactive</span> : null}
                {r.rewardItem.operationalDescription ? <span className="block text-[11px] text-muted-foreground">{r.rewardItem.operationalDescription}</span> : null}
              </td>
              <td className="px-3 py-2 text-xs">
                {r.binding && r.binding.active ? (
                  <>
                    <span className="font-medium">{r.binding.externalTitle}</span>
                    {r.binding.externalVariantTitle ? <> / {r.binding.externalVariantTitle}</> : null}
                    <span className="block font-mono text-[11px] text-muted-foreground">variant {r.binding.externalVariantId}, SKU {r.binding.externalSku ?? "none"}, £{r.binding.externalPrice ?? "?"}, {r.binding.externalStatus ?? "?"}</span>
                    <span className="block text-[11px] text-muted-foreground">{r.shopify?.shopDomain}. Recharge compatibility {r.binding.rechargeCompatibility.toLowerCase()}{r.binding.lastVerifiedAt ? `. Checked ${new Date(r.binding.lastVerifiedAt).toISOString().slice(0, 16).replace("T", " ")}` : ""}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">Not selected</span>
                )}
              </td>
              <td className="px-3 py-2"><StatusCell row={r} /></td>
              <td className="px-3 py-2 text-[11px] text-muted-foreground">{r.usage.milestones === 1 ? "1 milestone" : `${r.usage.milestones} milestones`}, {r.usage.programs === 1 ? "1 programme" : `${r.usage.programs} programmes`}</td>
              <td className="px-3 py-2 text-right">
                {canManage && r.shopify ? (
                  <span className="inline-flex items-center gap-1">
                    {r.binding && r.binding.active ? <VerifyBindingButton bindingId={r.binding.id} /> : null}
                    <BindRewardDialog rewardItemId={r.rewardItem.id} rewardName={r.rewardItem.name} shopifyIntegrationId={r.shopify.id} shopDomain={r.shopify.shopDomain} rebind={!!r.binding?.active} />
                    {r.binding && r.binding.active ? <UnbindButton bindingId={r.binding.id} rewardName={r.rewardItem.name} /> : null}
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BindRewardDialog({ rewardItemId, rewardName, shopifyIntegrationId, shopDomain, rebind }: { rewardItemId: string; rewardName: string; shopifyIntegrationId: string; shopDomain: string; rebind?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState(rewardName);
  const [results, setResults] = useState<ShopifyProductSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, startSearch] = useTransition();
  const [binding, startBind] = useTransition();

  function search() {
    setError(null);
    startSearch(async () => {
      const r = await searchShopifyCatalog({ shopifyIntegrationId, term });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setResults(r.data!);
    });
  }
  function bind(variantId: string) {
    setError(null);
    startBind(async () => {
      const r = await bindRewardToShopifyVariant({ rewardItemId, shopifyIntegrationId, variantId });
      if (!r.ok) {
        setError(r.error);
        toast.error(r.error);
        return;
      }
      toast.success(`${rewardName} linked to "${r.data!.title}"${r.data!.issues.length ? `. Notes: ${r.data!.issues.map((i) => ISSUE_HINT[i] ?? i).join(", ")}` : ""}`);
      setOpen(false);
      router.refresh();
    });
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) { setResults(null); setError(null); setTerm(rewardName); } }}>
      <DialogTrigger render={<span className="contents" />}><Button size="xs" variant={rebind ? "ghost" : "outline"}><Link2 data-icon="inline-start" /> {rebind ? "Change product" : "Choose product"}</Button></DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Choose the Shopify product for the {rewardName}</DialogTitle>
          <DialogDescription>Search {shopDomain} and pick the existing product that ships as this gift. The search only reads your catalogue and nothing is created or edited. Every journey that awards the {rewardName} will use the product you choose. You can also paste a numeric variant id.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search products… (name, SKU or variant id)" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); search(); } }} />
          <Button variant="outline" onClick={search} disabled={searching || !term.trim()}><Search data-icon="inline-start" /> {searching ? "Searching…" : "Search"}</Button>
        </div>
        {error ? <p className="rounded-lg border border-status-danger/30 bg-status-danger-bg px-3 py-2 text-xs text-status-danger">{error}</p> : null}
        {results !== null ? (
          results.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing found. Try another term, an SKU like sku:ABC, or the numeric variant id.</p>
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {results.map((p) => (
                <li key={p.productId} className="space-y-1 px-3 py-2">
                  <div className="text-sm font-medium">{p.title} <span className="text-[11px] font-normal text-muted-foreground">product {p.productId}, {p.status}{p.publishedOnlineStore === false ? ", not on the Online Store" : ""}</span></div>
                  <ul className="space-y-1">
                    {p.variants.map((v) => (
                      <li key={v.variantId} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span>{v.title && v.title !== "Default Title" ? v.title : "Default"}, <span className="font-mono">variant {v.variantId}</span>, SKU {v.sku ?? "none"}, £{v.price}{v.inventoryTracked ? ", tracked" : ""}{v.requiresShipping === false ? ", no shipping" : ""}</span>
                        <Button size="xs" disabled={binding} onClick={() => bind(v.variantId)}>{binding ? "Linking…" : "Use this variant"}</Button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )
        ) : null}
        <DialogFooter><Button variant="ghost" onClick={() => setOpen(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function VerifyBindingButton({ bindingId }: { bindingId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button size="xs" variant="ghost" disabled={pending} onClick={() => start(async () => {
      const r = await verifyRewardBindingNow(bindingId);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      if (r.data!.issues.length === 0) toast.success("Verified in Shopify. No issues.");
      else toast.message(`Verified. ${r.data!.issues.map((i) => ISSUE_HINT[i] ?? i).join(", ")}`);
      router.refresh();
    })}><ShieldCheck data-icon="inline-start" /> {pending ? "Verifying…" : "Verify"}</Button>
  );
}

export function UnbindButton({ bindingId, rewardName }: { bindingId: string; rewardName: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button size="xs" variant="ghost" disabled={pending} onClick={() => {
      if (!window.confirm(`Unbind ${rewardName} from its Shopify variant? Planned actions for this reward will be cancelled on the next planner run.`)) return;
      start(async () => {
        const r = await unbindReward({ bindingId });
        if (!r.ok) {
          toast.error(r.error);
          return;
        }
        toast.success(`${rewardName} unbound`);
        router.refresh();
      });
    }}>{pending ? "Unbinding…" : "Unbind"}</Button>
  );
}

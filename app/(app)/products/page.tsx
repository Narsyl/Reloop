import { Suspense } from "react";
import Link from "next/link";
import { Boxes, Tag } from "lucide-react";
import { requireOrg } from "@/lib/auth/tenancy";
import { countUnmappedSubscriptions, listMarkers, listPrograms, listSubscriptionProducts } from "@/lib/domain/queries/products";
import { activeStatus, enabledStatus, mappingStatus } from "@/lib/status";
import { formatRelative, pluralize } from "@/lib/format";
import { PageHeader, SectionHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/data/empty-state";
import { StatusBadge } from "@/components/status/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const metadata = { title: "Products" };

export default async function ProductsPage({ searchParams }: PageProps<"/products">) {
  const ctx = await requireOrg();
  const sp = await searchParams;
  const tab = typeof sp.tab === "string" && ["programs", "products", "markers"].includes(sp.tab) ? sp.tab : "programs";
  const [programs, products, markers, unmapped] = await Promise.all([
    listPrograms(ctx),
    listSubscriptionProducts(ctx),
    listMarkers(ctx),
    countUnmappedSubscriptions(ctx),
  ]);

  return (
    <>
      <PageHeader
        title="Products"
        description="Three separate things: catalogue products from your platform, subscription programs that group them into one milestone journey, and fulfilment markers — the £0 items inserted into shipments."
      />
      {unmapped > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-status-warning/30 bg-status-warning-bg px-4 py-3 text-sm">
          <span>
            <span className="font-medium text-status-warning">{pluralize(unmapped, "active subscription")}</span> not yet assigned to a subscription program. No journeys or automation run for them until they are.
          </span>
          <Link href="/subscriptions?mapping=UNMAPPED" className="shrink-0 text-xs font-medium text-primary hover:underline">
            View
          </Link>
        </div>
      )}

      <Tabs defaultValue={tab}>
        <TabsList variant="line">
          <TabsTrigger value="programs">Subscription programs ({programs.length})</TabsTrigger>
          <TabsTrigger value="products">Subscription products ({products.length})</TabsTrigger>
          <TabsTrigger value="markers">Fulfilment markers ({markers.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="programs" className="pt-4">
          <Suspense>
            {programs.length === 0 ? (
              <EmptyState icon={Boxes} title="No subscription programs" description="A program defines which products and variants share one delivery-cycle journey, e.g. 'Morning Magic Powder' including all its sizes. Programs are created in Phase 4 alongside the rule builder." />
            ) : (
              <ul className="grid gap-3 md:grid-cols-2">
                {programs.map((p) => (
                  <li key={p.id} className="space-y-3 rounded-xl border border-border bg-card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-semibold">{p.name}</h3>
                        {p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}
                      </div>
                      <StatusBadge status={activeStatus(p.active)} />
                    </div>
                    <ul className="space-y-1 text-sm">
                      {p.products.map((pp) => (
                        <li key={pp.id} className="flex items-center justify-between gap-2 text-muted-foreground">
                          <span className="truncate">
                            {pp.product.title}
                            {pp.variant ? <span> · {pp.variant.title}</span> : <span> · all variants</span>}
                          </span>
                          {pp.variant?.sku && <span className="font-mono text-[11px]">{pp.variant.sku}</span>}
                        </li>
                      ))}
                      {p.products.length === 0 && <li className="text-muted-foreground">No products mapped.</li>}
                    </ul>
                    <div className="flex gap-4 text-xs text-muted-foreground">
                      <span className="tnum">{pluralize(p.activeSubscriptions, "active subscription")}</span>
                      <span className="tnum">{pluralize(p._count.rules, "rule")}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Suspense>
        </TabsContent>

        <TabsContent value="products" className="pt-4">
          {products.length === 0 ? (
            <EmptyState icon={Boxes} title="No products imported" description="Products and variants are imported read-only when you connect a subscription platform." />
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              {products.map((pr) => (
                <li key={pr.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{pr.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {pluralize(pr.variants.length, "variant")} · {pluralize(pr._count.subscriptions, "subscription")}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {pr.programProducts.length === 0 ? (
                        <StatusBadge status={mappingStatus.UNMAPPED} />
                      ) : (
                        pr.programProducts.map((pp) => (
                          <span key={pp.id} className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium">
                            {pp.program.name}
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                  <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {pr.variants.map((v) => (
                      <li key={v.id}>
                        {v.title}
                        {v.sku && <span className="ml-1 font-mono text-[11px]">{v.sku}</span>}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="markers" className="pt-4">
          {markers.length === 0 ? (
            <EmptyState icon={Tag} title="No fulfilment markers" description="A marker is the £0 product that tells fulfilment what to include — e.g. 'Morning Magic 2' (SKU MM-CYCLE-02). Markers are created from an imported product in Phase 4." />
          ) : (
            <ul className="grid gap-3 md:grid-cols-2">
              {markers.map((m) => (
                <li key={m.id} className="space-y-3 rounded-xl border border-border bg-card p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold">{m.name}</h3>
                      <p className="text-xs text-muted-foreground">
                        {m.variant.product.title} · {m.variant.title}
                        {m.variant.sku && <span className="ml-1 font-mono">{m.variant.sku}</span>}
                      </p>
                    </div>
                    <StatusBadge status={activeStatus(m.active)} />
                  </div>
                  {m.description && <p className="text-sm text-foreground/80">{m.description}</p>}
                  <div className="space-y-1">
                    <SectionHeader title={<span className="text-xs text-muted-foreground">Used by</span>} />
                    {m.rules.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No rules yet.</p>
                    ) : (
                      <ul className="space-y-0.5 text-xs">
                        {m.rules.map((r) => (
                          <li key={r.id} className="flex items-center gap-2">
                            <Link href={`/rules/${r.id}`} className="hover:underline">{r.name}</Link>
                            <StatusBadge status={enabledStatus(r.enabled)} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="flex gap-4 text-xs text-muted-foreground">
                    <span className="tnum">{pluralize(m.usage.uses, "use")}</span>
                    <span>{m.usage.lastUsedAt ? `last used ${formatRelative(m.usage.lastUsedAt)}` : "never used"}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}

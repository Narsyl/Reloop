import { Suspense } from "react";
import Link from "next/link";
import { Boxes, Tag } from "lucide-react";
import { hasRole, requireOrg } from "@/lib/auth/tenancy";
import { countUnmappedSubscriptions, listMarkers, listPrograms, listSubscriptionProducts } from "@/lib/domain/queries/products";
import { listRewardItems } from "@/lib/domain/rewards/queries";
import { listMissingMarkers } from "@/lib/domain/markers/shopify";
import { MissingMarkersPanel, VerifyMarkerButton } from "@/components/domain/marker-shopify";
import { activeStatus, mappingStatus, ruleStatus } from "@/lib/status";
import { formatRelative, pluralize } from "@/lib/format";
import { PageHeader, SectionHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/data/empty-state";
import { StatusBadge } from "@/components/status/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { AssignProductDialog, CreateProgramDialog, RemoveMappingButton } from "@/components/domain/program-dialogs";
import { MarkerActiveToggle, MarkerDialog } from "@/components/domain/marker-dialog";
import { listIntegrations } from "@/lib/domain/queries/settings";

export const metadata = { title: "Products" };

export default async function ProductsPage({ searchParams }: PageProps<"/products">) {
  const ctx = await requireOrg();
  const sp = await searchParams;
  const tab = typeof sp.tab === "string" && ["programs", "products", "markers"].includes(sp.tab) ? sp.tab : "programs";
  const [programs, products, markers, unmapped, integrations, rewardItems, missingMarkers] = await Promise.all([listPrograms(ctx), listSubscriptionProducts(ctx), listMarkers(ctx), countUnmappedSubscriptions(ctx), listIntegrations(ctx), listRewardItems(ctx), listMissingMarkers(ctx)]);
  const shopifyConnected = integrations.some((i) => i.provider === "SHOPIFY" && i.status === "CONNECTED");
  const rewardItemOptions = rewardItems.filter((r) => r.active).map((r) => ({ id: r.id, name: r.name }));
  const canManage = hasRole(ctx, "ADMIN");
  const programOptions = programs.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name }));
  const integrationOptions = integrations.filter((i) => i.status !== "DISCONNECTED").map((i) => ({ id: i.id, displayName: i.displayName }));

  return (
    <>
      <PageHeader
        title="Products"
        description="Three separate things: catalogue products imported from your platform, subscription programs that group them into one milestone journey, and fulfilment markers — the £0 items inserted into shipments."
        actions={<CreateProgramDialog disabled={!canManage} />}
      />
      {unmapped > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-status-warning/30 bg-status-warning-bg px-4 py-3 text-sm">
          <span>
            <span className="font-medium text-status-warning">{pluralize(unmapped, "active subscription")}</span> not yet assigned to a subscription program. No delivery cycles are counted and no rules apply until they are. Map the products below.
          </span>
          <Link href="/subscriptions?mapping=UNMAPPED&status=ACTIVE" className="shrink-0 text-xs font-medium text-primary hover:underline">View subscriptions</Link>
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
              <EmptyState
                icon={Boxes}
                title="No subscription programs yet"
                description="A program defines which products and variants share one delivery-cycle journey, e.g. 'Morning Magic Powder' including every size. Create one, then assign imported products to it from the Subscription products tab."
                action={<CreateProgramDialog disabled={!canManage} />}
              />
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
                            {pp.variant?.sku && <span className="ml-1 font-mono text-[11px]">{pp.variant.sku}</span>}
                          </span>
                          {canManage && <RemoveMappingButton mappingId={pp.id} label={`${pp.product.title}${pp.variant ? ` · ${pp.variant.title}` : " (all variants)"}`} />}
                        </li>
                      ))}
                      {p.products.length === 0 && <li className="text-muted-foreground">No products mapped yet — assign from the Subscription products tab.</li>}
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
            <EmptyState icon={Boxes} title="No products imported" description="Products and variants are imported read-only when you connect a subscription platform." action={<Button variant="outline" render={<Link href="/settings/integrations" />}>Go to Integrations</Button>} />
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              {products.map((pr) => {
                const allMapping = pr.programProducts.find((pp) => pp.variantScope === "*");
                const variantMappings = new Map(pr.programProducts.filter((pp) => pp.variantId).map((pp) => [pp.variantId!, pp.program.name]));
                const assignable = {
                  id: pr.id,
                  title: pr.title,
                  allMappedTo: allMapping?.program.name ?? null,
                  variants: pr.variants.map((v) => ({ id: v.id, title: v.title, sku: v.sku, mappedTo: variantMappings.get(v.id) ?? null })),
                };
                const fullyMapped = !!allMapping || (pr.variants.length > 0 && pr.variants.every((v) => variantMappings.has(v.id)));
                return (
                  <li key={pr.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{pr.title}</div>
                        <div className="text-xs text-muted-foreground">
                          {pluralize(pr.variants.length, "variant")} · {pluralize(pr._count.subscriptions, "subscription")}
                          {!pr.active && " · inactive in platform"}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {pr.programProducts.length === 0 ? (
                          <StatusBadge status={mappingStatus.UNMAPPED} />
                        ) : (
                          [...new Set(pr.programProducts.map((pp) => pp.program.name))].map((name) => (
                            <span key={name} className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium">{name}</span>
                          ))
                        )}
                        {canManage && !fullyMapped && (
                          <AssignProductDialog product={assignable} programs={programOptions} trigger={<Button size="xs" variant="outline">{pr.programProducts.length === 0 ? "Assign to program" : "Assign remaining"}</Button>} />
                        )}
                      </div>
                    </div>
                    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {pr.variants.map((v) => (
                        <li key={v.id}>
                          {v.title}
                          {v.sku && <span className="ml-1 font-mono text-[11px]">{v.sku}</span>}
                          {variantMappings.get(v.id) && <span className="ml-1 text-[11px] text-foreground/70">→ {variantMappings.get(v.id)}</span>}
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="markers" className="pt-4">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <SectionHeader title="Fulfilment markers" description="The £0 items inserted into shipments. Identity = external variant id, scoped to one store. Saving a marker writes nothing to the platform." />
            {canManage && integrationOptions.length > 0 && <MarkerDialog integrations={integrationOptions} rewardItems={rewardItemOptions} />}
          </div>
          <div className="mb-6 rounded-xl border border-border bg-card p-4">
            <h3 className="mb-2 text-sm font-semibold">Missing fulfilment markers</h3>
            <MissingMarkersPanel rows={missingMarkers} canManage={canManage} shopifyConnected={shopifyConnected} />
          </div>
          {markers.length === 0 ? (
            <EmptyState
              icon={Tag}
              title="No fulfilment markers yet"
              description="Create one by reading the store's existing one-times (to pre-fill from your manual test item) or by entering the Shopify variant id, title and SKU directly."
              action={canManage && integrationOptions.length > 0 ? <MarkerDialog integrations={integrationOptions} rewardItems={rewardItemOptions} /> : undefined}
            />
          ) : (
            <ul className="grid gap-3 md:grid-cols-2">
              {markers.map((m) => (
                <li key={m.id} className="space-y-3 rounded-xl border border-border bg-card p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold">{m.name}{m.placeholder ? <span className="ml-2 rounded bg-status-warning-bg px-1.5 py-0.5 text-[11px] font-medium text-status-warning">placeholder · not executable</span> : null}</h3>
                      <p className="text-xs text-muted-foreground">
                        {m.title ?? m.variant.product.title}
                        {m.sku && <span className="ml-1 font-mono">{m.sku}</span>}
                        <span className="ml-1">· {m.integration.displayName}</span>
                      </p>
                      <p className="font-mono text-[11px] text-muted-foreground">variant {m.externalVariantId}{m.externalProductId ? ` · product ${m.externalProductId}` : ""} · {m.source.toLowerCase().replace(/_/g, " ")}</p>
                      <p className="text-xs">{m.rewardItem ? <><span className="font-medium">Reward: {m.rewardItem.name}</span>{m.operationalNote ? <span className="text-muted-foreground"> · {m.operationalNote}</span> : null}</> : <span className="text-status-warning">No reward item set — cannot be bound to a schedule milestone</span>}</p>
                      {m.milestoneBindings.length > 0 ? <p className="text-[11px] text-muted-foreground">Bound: {m.milestoneBindings.map((b) => `${b.program.name} · delivery ${b.milestone.cycleNumber} (${b.milestone.schedule.name})`).join(" · ")}</p> : null}
                      <p className="text-[11px] text-muted-foreground">Shopify: {m.shopifyStatus ? <>{m.shopifyStatus}{m.shopifyPublishedOnlineStore === null ? "" : m.shopifyPublishedOnlineStore ? " · Online Store published" : " · NOT on Online Store"}{m.shopifyPrice ? ` · £${m.shopifyPrice}` : ""}{m.shopifyInventoryTracked ? " · inventory tracked" : ""}{m.lastVerifiedAt ? ` · verified ${m.lastVerifiedAt.toISOString().slice(0, 16).replace("T", " ")}` : ""}</> : "not verified yet"} · Recharge compatibility {m.rechargeCompatibility.toLowerCase()}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <StatusBadge status={activeStatus(m.active)} />
                      {!m.placeholder ? <VerifyMarkerButton markerId={m.id} /> : null}
                      {canManage && (
                        <div className="flex items-center gap-1">
                          <MarkerDialog
                            integrations={integrationOptions}
                            rewardItems={rewardItemOptions}
                            initial={{ id: m.id, integrationId: m.integrationId, name: m.name, description: m.description ?? "", externalVariantId: m.externalVariantId, externalProductId: m.externalProductId ?? "", title: m.title ?? "", sku: m.sku ?? "", source: m.source, placeholder: m.placeholder, rewardItemId: m.rewardItemId ?? "", operationalNote: m.operationalNote ?? "" }}
                            trigger={<Button size="xs" variant="ghost">Edit</Button>}
                          />
                          <MarkerActiveToggle id={m.id} name={m.name} active={m.active} usedByRules={m.rules.filter((r) => r.status === "READY" || r.status === "ACTIVE").length} />
                        </div>
                      )}
                    </div>
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
                            <StatusBadge status={ruleStatus[r.status]} />
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

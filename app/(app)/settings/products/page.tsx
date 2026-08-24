import { Suspense } from "react";
import Link from "next/link";
import { Boxes } from "lucide-react";
import { hasRole, requireOrg } from "@/lib/auth/tenancy";
import { countUnmappedSubscriptions, listMarkers, listPrograms, listSubscriptionProducts } from "@/lib/domain/queries/products";
import { activeStatus, mappingStatus } from "@/lib/status";
import { formatRelative, pluralize } from "@/lib/format";
import { SectionHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/data/empty-state";
import { StatusBadge } from "@/components/status/status-badge";
import { TechnicalDetails } from "@/components/data/technical-details";
import { Button } from "@/components/ui/button";
import { AssignProductDialog, CreateProgramDialog, RemoveMappingButton } from "@/components/domain/program-dialogs";

export const metadata = { title: "Programmes and products" };

export default async function SettingsProductsPage() {
  const ctx = await requireOrg();
  const [programs, products, markers, unmapped] = await Promise.all([listPrograms(ctx), listSubscriptionProducts(ctx), listMarkers(ctx), countUnmappedSubscriptions(ctx)]);
  const canManage = hasRole(ctx, "ADMIN");
  const programOptions = programs.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name }));

  return (
    <div className="space-y-8 pt-6">
      {unmapped > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-status-warning/30 bg-status-warning-bg px-4 py-3 text-sm">
          <span>
            <span className="font-medium text-status-warning">{pluralize(unmapped, "active subscription")}</span> not in a programme yet. Deliveries are not counted and no gifts are planned until the product joins one.
          </span>
          <Link href="/subscriptions?mapping=UNMAPPED&status=ACTIVE" className="shrink-0 text-xs font-medium text-primary hover:underline">View subscriptions</Link>
        </div>
      )}

      <section className="space-y-3">
        <SectionHeader
          title="Programmes"
          description="A programme groups the products that share one reward journey."
          actions={<CreateProgramDialog disabled={!canManage} />}
        />
        <Suspense>
          {programs.length === 0 ? (
            <EmptyState
              icon={Boxes}
              title="No programmes yet"
              description="Create a programme, for example Morning Magic Powder including every size, then assign imported products to it below."
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
                          {pp.variant ? <span>, {pp.variant.title}</span> : <span>, all variants</span>}
                          {pp.variant?.sku && <span className="ml-1 font-mono text-[11px]">{pp.variant.sku}</span>}
                        </span>
                        {canManage && <RemoveMappingButton mappingId={pp.id} label={`${pp.product.title}${pp.variant ? `, ${pp.variant.title}` : ", all variants"}`} />}
                      </li>
                    ))}
                    {p.products.length === 0 && <li className="text-muted-foreground">No products in this programme yet. Assign them below.</li>}
                  </ul>
                  <div className="flex gap-4 text-xs text-muted-foreground">
                    <span className="tnum">{pluralize(p.activeSubscriptions, "active subscription")}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Suspense>
      </section>

      <section className="space-y-3">
        <SectionHeader title="Products" description="Imported from your platform when it connects. The import only reads." />
        {products.length === 0 ? (
          <EmptyState icon={Boxes} title="No products imported" description="Products arrive automatically once a platform is connected." action={<Button variant="outline" render={<Link href="/settings/integrations" />}>Open Connections</Button>} />
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
                        {pluralize(pr.variants.length, "variant")}, {pluralize(pr._count.subscriptions, "subscription")}
                        {!pr.active && ". Inactive in the platform"}
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
                        <AssignProductDialog product={assignable} programs={programOptions} trigger={<Button size="xs" variant="outline">{pr.programProducts.length === 0 ? "Add to a programme" : "Assign the rest"}</Button>} />
                      )}
                    </div>
                  </div>
                  <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {pr.variants.map((v) => (
                      <li key={v.id}>
                        {v.title}
                        {v.sku && <span className="ml-1 font-mono text-[11px]">{v.sku}</span>}
                        {variantMappings.get(v.id) && <span className="ml-1 text-[11px] text-foreground/70">in {variantMappings.get(v.id)}</span>}
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {markers.length > 0 ? (
        <TechnicalDetails label={`Legacy fulfilment markers (${markers.length})`}>
          <p className="mb-3 text-[13px]">
            Marker aliases from the earlier model, kept for the audit record. Gifts now resolve through the gift products under <Link href="/rewards" className="underline">Rewards</Link>.
          </p>
          <ul className="space-y-3">
            {markers.map((m) => (
              <li key={m.id} className="rounded-lg border border-border/60 bg-background/60 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-0.5">
                    <div className="text-[13px] font-medium text-foreground">
                      {m.name}
                      {m.placeholder ? <span className="ml-2 rounded bg-status-warning-bg px-1.5 py-0.5 text-[11px] font-medium text-status-warning">placeholder</span> : null}
                    </div>
                    <p className="text-[12px]">{m.title ?? m.variant.product.title}{m.sku ? `, ${m.sku}` : ""}, {m.integration.displayName}</p>
                    <p className="font-mono text-[11px]">variant {m.externalVariantId}{m.externalProductId ? `, product ${m.externalProductId}` : ""}, {m.source.toLowerCase().replace(/_/g, " ")}</p>
                    {m.rewardItem ? <p className="text-[12px]">Gift: {m.rewardItem.name}{m.operationalNote ? `. ${m.operationalNote}` : ""}</p> : null}
                    {m.milestoneBindings.length > 0 ? <p className="text-[11px]">Was bound to {m.milestoneBindings.map((b) => `${b.program.name} delivery ${b.milestone.cycleNumber} (${b.milestone.schedule.name})`).join(", ")}</p> : null}
                    <p className="tnum text-[11px]">{pluralize(m.usage.uses, "use")}{m.usage.lastUsedAt ? `, last used ${formatRelative(m.usage.lastUsedAt)}` : ", never used"}</p>
                  </div>
                  <StatusBadge status={activeStatus(m.active)} />
                </div>
              </li>
            ))}
          </ul>
        </TechnicalDetails>
      ) : null}
    </div>
  );
}

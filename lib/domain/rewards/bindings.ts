/**
 * Reward item ↔ external fulfilment variant bindings (revised Phase 4c).
 *
 *   RewardScheduleMilestone → RewardItem → RewardItemExternalBinding (per commerce integration) → existing
 *   Shopify ProductVariant (Whisk, Cup, Spoon…)
 *
 * The PHYSICAL reward item owns its variant; every programme/milestone that awards the item resolves to
 * the same variant. Shopify is read-only here: search, pick, store the canonical product/variant ids and a
 * verified snapshot, re-verify later. Nothing is created or edited in Shopify, and nothing here touches
 * Recharge, cycles, charges or actions.
 */
import { Prisma } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import { logActivity } from "@/lib/domain/activity/log";
import { findShopifyIntegrationForRecharge, getShopifyConnectorForIntegration, listShopifyIntegrations, type ShopifyIntegrationSettings } from "@/lib/domain/integrations/shopify";
import type { ShopifyProductSummary, ShopifyVariantSummary } from "@/lib/integrations/shopify";

type Ctx = { organizationId: string; userId?: string | null };
type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

// ── verification rules ─────────────────────────────────────────────────────

export type BindingIssue =
  | "MISSING_IN_SHOPIFY" // variant/product no longer exists — blocking
  | "DRAFT_OR_ARCHIVED" // product not available to apps/Recharge — blocking
  | "NOT_REQUIRING_SHIPPING" // physical reward must ship — warning
  | "INVENTORY_TRACKED" // stock could block the one-time — info
  | "NOT_PUBLISHED_ONLINE_STORE" // info (only when publications are readable)
  | "PRICED"; // one-time will be created at 0.00; Recharge compatibility unverified until the controlled test — info

export const BLOCKING_BINDING_ISSUES: ReadonlySet<BindingIssue> = new Set(["MISSING_IN_SHOPIFY", "DRAFT_OR_ARCHIVED"]);

export const BINDING_ISSUE_LABEL: Record<BindingIssue, string> = {
  MISSING_IN_SHOPIFY: "Variant no longer exists in Shopify",
  DRAFT_OR_ARCHIVED: "Product is DRAFT/ARCHIVED — unavailable to apps and Recharge",
  NOT_REQUIRING_SHIPPING: "Variant does not require shipping — a physical reward must ship",
  INVENTORY_TRACKED: "Inventory is tracked — stock could block the one-time",
  NOT_PUBLISHED_ONLINE_STORE: "Not published to the Online Store sales channel",
  PRICED: "Variant has a price — the one-time will be added at 0.00 (Recharge compatibility unverified)",
};

export function bindingIssues(product: ShopifyProductSummary | null, variant: ShopifyVariantSummary | null): BindingIssue[] {
  if (!product || !variant) return ["MISSING_IN_SHOPIFY"];
  const issues: BindingIssue[] = [];
  if (product.status === "DRAFT" || product.status === "ARCHIVED") issues.push("DRAFT_OR_ARCHIVED");
  if (variant.requiresShipping === false) issues.push("NOT_REQUIRING_SHIPPING");
  if (variant.inventoryTracked === true) issues.push("INVENTORY_TRACKED");
  if (product.publishedOnlineStore === false) issues.push("NOT_PUBLISHED_ONLINE_STORE");
  if (Number(variant.price) > 0) issues.push("PRICED");
  return issues;
}

export function blockingIssuesOf(issues: readonly string[] | null | undefined): BindingIssue[] {
  return (issues ?? []).filter((i): i is BindingIssue => BLOCKING_BINDING_ISSUES.has(i as BindingIssue));
}

// ── listing ────────────────────────────────────────────────────────────────

export type RewardBindingStatus = "NO_SHOPIFY" | "NEEDS_BINDING" | "BOUND" | "BLOCKED" | "INACTIVE";

export type RewardBindingRow = {
  rewardItem: { id: string; name: string; operationalDescription: string | null; active: boolean };
  shopify: { id: string; displayName: string; shopDomain: string } | null;
  binding: {
    id: string;
    externalProductId: string;
    externalVariantId: string;
    externalTitle: string;
    externalVariantTitle: string | null;
    externalSku: string | null;
    externalPrice: string | null;
    externalStatus: string | null;
    externalHandle: string | null;
    requiresShipping: boolean | null;
    inventoryTracked: boolean | null;
    active: boolean;
    lastVerifiedAt: Date | null;
    issues: string[];
    rechargeCompatibility: string;
  } | null;
  status: RewardBindingStatus;
  usage: { milestones: number; programs: number };
};

function settingsOf(json: unknown): Partial<ShopifyIntegrationSettings> {
  return (json as Partial<ShopifyIntegrationSettings> | null) ?? {};
}

export async function listRewardBindings(ctx: { organizationId: string }): Promise<{ rows: RewardBindingRow[]; shopifyIntegrations: { id: string; displayName: string; shopDomain: string; pairedIntegrationId: string | null }[] }> {
  const db = dbFor(ctx);
  const [items, shops, bindings] = await Promise.all([
    db.rewardItem.findMany({ orderBy: { name: "asc" }, include: { milestones: { select: { id: true, schedule: { select: { programs: { select: { id: true } } } } } } } }),
    listShopifyIntegrations(ctx),
    db.rewardItemExternalBinding.findMany({ select: { id: true, rewardItemId: true, integrationId: true, externalProductId: true, externalVariantId: true, externalTitle: true, externalVariantTitle: true, externalSku: true, externalPrice: true, externalStatus: true, externalHandle: true, requiresShipping: true, inventoryTracked: true, active: true, lastVerifiedAt: true, verificationJson: true, rechargeCompatibility: true } }),
  ]);
  const shopifyIntegrations = shops.map((s) => ({ id: s.id, displayName: s.displayName, shopDomain: settingsOf(s.settingsJson).shopDomain ?? s.externalStoreId, pairedIntegrationId: s.pairedIntegrationId }));
  const rows: RewardBindingRow[] = [];
  for (const item of items) {
    const programs = new Set<string>();
    for (const m of item.milestones) for (const p of m.schedule.programs) programs.add(p.id);
    const usage = { milestones: item.milestones.length, programs: programs.size };
    const targets = shopifyIntegrations.length ? shopifyIntegrations : [null];
    for (const shop of targets) {
      const b = shop ? (bindings.find((x) => x.rewardItemId === item.id && x.integrationId === shop.id) ?? null) : null;
      const issues = b ? (((b.verificationJson as { issues?: string[] } | null)?.issues ?? []) as string[]) : [];
      const status: RewardBindingStatus = !shop ? "NO_SHOPIFY" : !b ? "NEEDS_BINDING" : !b.active ? "INACTIVE" : blockingIssuesOf(issues).length ? "BLOCKED" : "BOUND";
      rows.push({
        rewardItem: { id: item.id, name: item.name, operationalDescription: item.operationalDescription, active: item.active },
        shopify: shop ? { id: shop.id, displayName: shop.displayName, shopDomain: shop.shopDomain } : null,
        binding: b ? { id: b.id, externalProductId: b.externalProductId, externalVariantId: b.externalVariantId, externalTitle: b.externalTitle, externalVariantTitle: b.externalVariantTitle, externalSku: b.externalSku, externalPrice: b.externalPrice, externalStatus: b.externalStatus, externalHandle: b.externalHandle, requiresShipping: b.requiresShipping, inventoryTracked: b.inventoryTracked, active: b.active, lastVerifiedAt: b.lastVerifiedAt, issues, rechargeCompatibility: b.rechargeCompatibility } : null,
        status,
        usage,
      });
    }
  }
  return { rows, shopifyIntegrations };
}

/** Bindings of every reward item on the Shopify store paired with a Recharge integration (resolver input). */
export async function bindingsForRechargeStore(ctx: { organizationId: string }, rechargeIntegrationId: string): Promise<{ shopifyIntegrationId: string | null; byRewardItem: Map<string, ResolvedBinding> }> {
  const shop = await findShopifyIntegrationForRecharge(ctx, rechargeIntegrationId);
  if (!shop) return { shopifyIntegrationId: null, byRewardItem: new Map() };
  const rows = await dbFor(ctx).rewardItemExternalBinding.findMany({ where: { integrationId: shop.id }, select: { id: true, rewardItemId: true, integrationId: true, externalProductId: true, externalVariantId: true, externalTitle: true, externalVariantTitle: true, externalSku: true, externalPrice: true, externalStatus: true, active: true, lastVerifiedAt: true, verificationJson: true, rechargeCompatibility: true } });
  const byRewardItem = new Map<string, ResolvedBinding>();
  for (const b of rows) {
    const issues = ((b.verificationJson as { issues?: string[] } | null)?.issues ?? []) as string[];
    byRewardItem.set(b.rewardItemId, { id: b.id, integrationId: b.integrationId, externalProductId: b.externalProductId, externalVariantId: b.externalVariantId, externalTitle: b.externalTitle, externalVariantTitle: b.externalVariantTitle, externalSku: b.externalSku, externalPrice: b.externalPrice, externalStatus: b.externalStatus, active: b.active, lastVerifiedAt: b.lastVerifiedAt, blockingIssues: blockingIssuesOf(issues), rechargeCompatibility: b.rechargeCompatibility });
  }
  return { shopifyIntegrationId: shop.id, byRewardItem };
}

export type ResolvedBinding = {
  id: string;
  integrationId: string;
  externalProductId: string;
  externalVariantId: string;
  externalTitle: string;
  externalVariantTitle: string | null;
  externalSku: string | null;
  externalPrice: string | null;
  externalStatus: string | null;
  active: boolean;
  lastVerifiedAt: Date | null;
  blockingIssues: BindingIssue[];
  rechargeCompatibility: string;
};

// ── search (read-only) ─────────────────────────────────────────────────────

export async function searchCatalog(ctx: { organizationId: string }, shopifyIntegrationId: string, term: string): Promise<ShopifyProductSummary[]> {
  const { connector } = await getShopifyConnectorForIntegration(ctx, shopifyIntegrationId, { correlationId: "rb_search" });
  const t = term.trim();
  if (!t) return [];
  // a bare numeric id (or gid) is looked up directly as a variant id, then as a product id
  const idMatch = /^(?:gid:\/\/shopify\/(ProductVariant|Product)\/)?(\d{4,})$/.exec(t);
  if (idMatch) {
    const out: ShopifyProductSummary[] = [];
    if (idMatch[1] !== "Product") {
      const byVariant = await connector.getProductByVariantId(idMatch[2]);
      if (byVariant) out.push(byVariant);
    }
    if (idMatch[1] !== "ProductVariant" && out.length === 0) {
      const byProduct = await connector.getProduct(idMatch[2]);
      if (byProduct) out.push(byProduct);
    }
    if (out.length) return out;
  }
  return connector.search(t, 15);
}

// ── bind / unbind / verify ─────────────────────────────────────────────────

export async function bindRewardItem(ctx: Ctx, input: { rewardItemId: string; shopifyIntegrationId: string; variantId: string }): Promise<Result<{ bindingId: string; product: ShopifyProductSummary; variant: ShopifyVariantSummary; issues: BindingIssue[] }>> {
  const db = dbFor(ctx);
  const item = await db.rewardItem.findUnique({ where: { id: input.rewardItemId }, select: { id: true, name: true } });
  if (!item) return { ok: false, error: "Reward item not found." };
  const variantId = input.variantId.trim().replace(/^gid:\/\/shopify\/ProductVariant\//, "");
  if (!/^\d+$/.test(variantId)) return { ok: false, error: "Choose a Shopify variant (numeric variant id)." };
  const { connector, integration } = await getShopifyConnectorForIntegration(ctx, input.shopifyIntegrationId, { correlationId: `rb_bind_${item.id.slice(-6)}` });
  const product = await connector.getProductByVariantId(variantId);
  const variant = product?.variants.find((v) => v.variantId === variantId) ?? null;
  if (!product || !variant) return { ok: false, error: `No Shopify variant ${variantId} in ${connector.shopDomain}.` };
  const issues = bindingIssues(product, variant);
  const snapshot = {
    provider: "SHOPIFY" as const,
    externalProductId: product.productId,
    externalVariantId: variant.variantId,
    externalTitle: product.title,
    externalVariantTitle: variant.title && variant.title !== "Default Title" ? variant.title : null,
    externalSku: variant.sku,
    externalPrice: variant.price,
    externalStatus: product.status,
    externalHandle: product.handle,
    requiresShipping: variant.requiresShipping,
    inventoryTracked: variant.inventoryTracked,
    active: true,
    lastVerifiedAt: new Date(),
    verificationJson: { checkedAt: new Date().toISOString(), issues, product } as unknown as Prisma.InputJsonValue,
  };
  const previous = await db.rewardItemExternalBinding.findUnique({ where: { rewardItemId_integrationId: { rewardItemId: item.id, integrationId: integration.id } }, select: { id: true, externalVariantId: true, externalProductId: true, externalTitle: true, externalSku: true, active: true } });
  let bindingId: string;
  try {
    if (previous) {
      const changed = previous.externalVariantId !== variant.variantId;
      await db.rewardItemExternalBinding.update({ where: { id: previous.id }, data: { ...snapshot, ...(changed ? { rechargeCompatibility: "UNVERIFIED" } : {}) } });
      bindingId = previous.id;
    } else {
      bindingId = (await db.rewardItemExternalBinding.create({ data: { organizationId: ctx.organizationId, rewardItemId: item.id, integrationId: integration.id, createdById: ctx.userId ?? null, ...snapshot } })).id;
    }
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const clash = await db.rewardItemExternalBinding.findFirst({ where: { integrationId: integration.id, externalVariantId: variant.variantId }, select: { rewardItem: { select: { name: true } } } });
      return { ok: false, error: `Shopify variant ${variant.variantId} ("${product.title}") is already bound to "${clash?.rewardItem.name ?? "another reward item"}". One variant can represent only one physical reward.` };
    }
    throw e;
  }
  await logActivity(ctx, {
    actorType: ctx.userId ? "USER" : "SYSTEM",
    actorId: ctx.userId ?? null,
    eventType: previous ? (previous.externalVariantId === variant.variantId ? "REWARD_BINDING_REFRESHED" : "REWARD_REBOUND") : "REWARD_BOUND",
    entityType: "REWARD_ITEM",
    entityId: item.id,
    summary: `"${item.name}" → Shopify "${product.title}"${snapshot.externalVariantTitle ? ` / ${snapshot.externalVariantTitle}` : ""} (product ${product.productId}, variant ${variant.variantId}, SKU ${variant.sku ?? "—"}, £${variant.price}, ${product.status}) on ${connector.shopDomain}${issues.length ? ` · notes: ${issues.join(", ")}` : ""}${previous && previous.externalVariantId !== variant.variantId ? ` · replaced variant ${previous.externalVariantId} ("${previous.externalTitle}")` : ""}. Recharge compatibility: UNVERIFIED until the controlled test.`,
    metadata: { bindingId, shopifyIntegrationId: integration.id, productId: product.productId, variantId: variant.variantId, sku: variant.sku, price: variant.price, status: product.status, issues, previous },
  });
  return { ok: true, data: { bindingId, product, variant, issues } };
}

export async function unbindRewardItem(ctx: Ctx, input: { bindingId: string }): Promise<Result> {
  const db = dbFor(ctx);
  const b = await db.rewardItemExternalBinding.findUnique({ where: { id: input.bindingId }, include: { rewardItem: { select: { id: true, name: true } }, integration: { select: { id: true, pairedIntegrationId: true, externalStoreId: true } } } });
  if (!b) return { ok: false, error: "Binding not found." };
  const live = await db.automationAction.count({ where: { rewardItemId: b.rewardItemId, status: { in: ["EXECUTING", "ATTACHED"] }, ...(b.integration.pairedIntegrationId ? { integrationId: b.integration.pairedIntegrationId } : {}) } });
  if (live > 0) return { ok: false, error: `${live} action(s) for "${b.rewardItem.name}" are attaching/attached; the binding cannot be removed until they complete.` };
  await db.rewardItemExternalBinding.update({ where: { id: b.id }, data: { active: false } });
  await logActivity(ctx, { actorType: ctx.userId ? "USER" : "SYSTEM", actorId: ctx.userId ?? null, eventType: "REWARD_UNBOUND", entityType: "REWARD_ITEM", entityId: b.rewardItemId, summary: `"${b.rewardItem.name}" unbound from Shopify variant ${b.externalVariantId} ("${b.externalTitle}") on ${b.integration.externalStoreId}. Planned actions for this reward will be cancelled (REWARD_UNBOUND) on the next planner run.`, metadata: { bindingId: b.id, variantId: b.externalVariantId, productId: b.externalProductId } });
  return { ok: true };
}

export async function verifyRewardBinding(ctx: Ctx, bindingId: string): Promise<Result<{ issues: BindingIssue[]; product: ShopifyProductSummary | null }>> {
  const db = dbFor(ctx);
  const b = await db.rewardItemExternalBinding.findUnique({ where: { id: bindingId }, include: { rewardItem: { select: { name: true } } } });
  if (!b) return { ok: false, error: "Binding not found." };
  const { connector } = await getShopifyConnectorForIntegration(ctx, b.integrationId, { correlationId: `rb_verify_${b.id.slice(-6)}` });
  const product = await connector.getProductByVariantId(b.externalVariantId);
  const variant = product?.variants.find((v) => v.variantId === b.externalVariantId) ?? null;
  const issues = bindingIssues(product, variant);
  await db.rewardItemExternalBinding.update({
    where: { id: b.id },
    data: {
      externalTitle: product?.title ?? b.externalTitle,
      externalVariantTitle: variant ? (variant.title && variant.title !== "Default Title" ? variant.title : null) : b.externalVariantTitle,
      externalSku: variant?.sku ?? b.externalSku,
      externalPrice: variant?.price ?? b.externalPrice,
      externalStatus: product?.status ?? null,
      externalHandle: product?.handle ?? b.externalHandle,
      requiresShipping: variant?.requiresShipping ?? null,
      inventoryTracked: variant?.inventoryTracked ?? null,
      lastVerifiedAt: new Date(),
      verificationJson: { checkedAt: new Date().toISOString(), issues, product } as unknown as Prisma.InputJsonValue,
    },
  });
  await logActivity(ctx, { actorType: ctx.userId ? "USER" : "SYSTEM", actorId: ctx.userId ?? null, eventType: "REWARD_BINDING_VERIFIED", entityType: "REWARD_ITEM", entityId: b.rewardItemId, summary: `Verified "${b.rewardItem.name}" → Shopify variant ${b.externalVariantId}: ${product ? `"${product.title}" ${product.status}, £${variant?.price ?? "?"}, SKU ${variant?.sku ?? "—"}` : "variant MISSING"}${issues.length ? ` · notes: ${issues.join(", ")}` : " · no issues"}`, metadata: { bindingId: b.id, issues } });
  return { ok: true, data: { issues, product } };
}

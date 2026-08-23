"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ForbiddenError, requireRole } from "@/lib/auth/tenancy";
import type { ActionResult } from "@/lib/domain/organizations/actions";
import type { ShopifyProductSummary } from "@/lib/integrations/shopify";
import { getShopifyConnectorForIntegration } from "@/lib/domain/integrations/shopify";
import { adoptShopifyVariant, createMarkerInShopify, findExistingMarkerCandidates, listMissingMarkers, setProgramMarkerNaming, verifyMarkerInShopify, type ExistingCandidate, type MarkerIssue, type MissingMarkerRow } from "./shopify";

async function role(minimum: "ADMIN" | "OPERATOR") {
  try {
    return await requireRole(minimum);
  } catch (e) {
    if (e instanceof ForbiddenError) return null;
    throw e;
  }
}
const DENIED = { ok: false as const, error: "You need the Admin or Owner role to manage fulfilment markers." };
function revalidateMarkers() {
  revalidatePath("/products");
  revalidatePath("/rewards");
  revalidatePath("/upcoming");
}

export async function previewMissingMarkers(): Promise<ActionResult<MissingMarkerRow[]>> {
  const ctx = await role("OPERATOR");
  if (!ctx) return { ok: false, error: "You need the Operator role or above." };
  return { ok: true, data: await listMissingMarkers(ctx) };
}

export async function saveProgramMarkerNaming(input: unknown): Promise<ActionResult> {
  const ctx = await role("ADMIN");
  if (!ctx) return DENIED;
  const parsed = z.object({ programId: z.string().min(1), markerLabel: z.string().trim().min(2).max(60), skuPrefix: z.string().trim().min(1).max(30) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Please check the form.", fieldErrors: z.flattenError(parsed.error).fieldErrors };
  const r = await setProgramMarkerNaming(ctx, parsed.data);
  if (r.ok) revalidateMarkers();
  return r;
}

/** Duplicate check against Shopify (variant id / SKU / title) and internal markers. Read-only. */
export async function checkExistingMarker(input: unknown): Promise<ActionResult<ExistingCandidate[]>> {
  const ctx = await role("OPERATOR");
  if (!ctx) return { ok: false, error: "You need the Operator role or above." };
  const parsed = z.object({ shopifyIntegrationId: z.string().min(1), rechargeIntegrationId: z.string().min(1).nullable(), sku: z.string().trim().min(1), title: z.string().trim().min(1), variantId: z.string().trim().optional().or(z.literal("")) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  try {
    const { connector } = await getShopifyConnectorForIntegration(ctx, parsed.data.shopifyIntegrationId, { correlationId: "mk_dupcheck" });
    const candidates = await findExistingMarkerCandidates(ctx, connector, { sku: parsed.data.sku.toUpperCase(), title: parsed.data.title, variantId: parsed.data.variantId || null, shopifyIntegrationId: parsed.data.shopifyIntegrationId, rechargeIntegrationId: parsed.data.rechargeIntegrationId });
    return { ok: true, data: candidates };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Explicit, confirmed Shopify write: create the marker product and bind it. */
export async function createMarkerFromShopify(input: unknown): Promise<ActionResult<{ markerId: string; productId: string; variantId: string; product: ShopifyProductSummary }> & { code?: string; candidates?: ExistingCandidate[] }> {
  const ctx = await role("ADMIN");
  if (!ctx) return DENIED;
  const parsed = z.object({ programId: z.string().min(1), milestoneId: z.string().min(1), title: z.string().trim().min(2).max(120), sku: z.string().trim().min(3).max(64), operationalNote: z.string().trim().max(200).optional().or(z.literal("")), replaceMarkerId: z.string().min(1).nullable().optional(), acknowledgeCandidates: z.boolean().optional() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Please check the form.", fieldErrors: z.flattenError(parsed.error).fieldErrors };
  try {
    const r = await createMarkerInShopify(ctx, { ...parsed.data, operationalNote: parsed.data.operationalNote || null, replaceMarkerId: parsed.data.replaceMarkerId ?? null });
    if (r.ok) revalidateMarkers();
    return r;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function adoptMarkerFromShopify(input: unknown): Promise<ActionResult<{ markerId: string; product: ShopifyProductSummary }>> {
  const ctx = await role("ADMIN");
  if (!ctx) return DENIED;
  const parsed = z.object({ programId: z.string().min(1), milestoneId: z.string().min(1), variantId: z.string().trim().min(1), name: z.string().trim().max(80).optional().or(z.literal("")), operationalNote: z.string().trim().max(200).optional().or(z.literal("")), replaceMarkerId: z.string().min(1).nullable().optional() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Please check the form.", fieldErrors: z.flattenError(parsed.error).fieldErrors };
  try {
    const r = await adoptShopifyVariant(ctx, { ...parsed.data, name: parsed.data.name || null, operationalNote: parsed.data.operationalNote || null, replaceMarkerId: parsed.data.replaceMarkerId ?? null });
    if (r.ok) revalidateMarkers();
    return r;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function verifyMarker(markerId: string): Promise<ActionResult<{ issues: MarkerIssue[]; product: ShopifyProductSummary | null }>> {
  const ctx = await role("OPERATOR");
  if (!ctx) return { ok: false, error: "You need the Operator role or above." };
  try {
    const r = await verifyMarkerInShopify(ctx, markerId);
    if (r.ok) revalidateMarkers();
    return r;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

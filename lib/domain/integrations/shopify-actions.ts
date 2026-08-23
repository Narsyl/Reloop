"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ForbiddenError, requireRole } from "@/lib/auth/tenancy";
import type { ActionResult } from "@/lib/domain/organizations/actions";
import type { ShopifyCapabilityReport } from "@/lib/integrations/shopify";
import { connectShopifyIntegration, recheckShopifyIntegration, testShopifyCredentials } from "./shopify";

async function admin() {
  try {
    return await requireRole("ADMIN");
  } catch (e) {
    if (e instanceof ForbiddenError) return null;
    throw e;
  }
}
const DENIED = { ok: false as const, error: "You need the Admin or Owner role to manage integrations." };

const credsSchema = z.object({
  shopDomain: z.string().trim().min(6, "Enter the myshopify.com domain."),
  accessToken: z.string().trim().min(20, "Paste the custom app's Admin API access token (shpat_…)."),
});

/** Read-only probe: store identity + granted scopes + capability report. Nothing is saved. */
export async function testShopifyConnection(input: unknown): Promise<ActionResult<ShopifyCapabilityReport>> {
  const ctx = await admin();
  if (!ctx) return DENIED;
  const parsed = credsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Please check the form.", fieldErrors: z.flattenError(parsed.error).fieldErrors };
  return testShopifyCredentials(parsed.data);
}

export async function connectShopify(input: unknown): Promise<ActionResult<{ integrationId: string; report: ShopifyCapabilityReport }>> {
  const ctx = await admin();
  if (!ctx) return DENIED;
  const parsed = credsSchema.extend({ pairedIntegrationId: z.string().min(1).nullable(), displayName: z.string().trim().max(80).optional().or(z.literal("")) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Please check the form.", fieldErrors: z.flattenError(parsed.error).fieldErrors };
  const r = await connectShopifyIntegration(ctx, { shopDomain: parsed.data.shopDomain, accessToken: parsed.data.accessToken, pairedIntegrationId: parsed.data.pairedIntegrationId, displayName: parsed.data.displayName || null });
  if (r.ok) {
    revalidatePath("/settings/integrations");
    revalidatePath("/products");
  }
  return r;
}

export async function recheckShopifyCapabilities(integrationId: string): Promise<ActionResult<ShopifyCapabilityReport>> {
  const ctx = await admin();
  if (!ctx) return DENIED;
  const r = await recheckShopifyIntegration(ctx, integrationId);
  if (r.ok) {
    revalidatePath("/settings/integrations");
    revalidatePath(`/settings/integrations/${integrationId}`);
  }
  return r;
}

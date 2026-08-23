"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ForbiddenError, requireRole } from "@/lib/auth/tenancy";
import type { ActionResult } from "@/lib/domain/organizations/actions";
import { registerRechargeWebhooks, unregisterRechargeWebhooks, updateRechargeWebhookSecret } from "./recharge";

async function admin() {
  try {
    return await requireRole("ADMIN");
  } catch (e) {
    if (e instanceof ForbiddenError) return null;
    throw e;
  }
}
const DENIED = { ok: false as const, error: "You need the Admin or Owner role to manage webhooks." };

/** Store the Recharge API client secret (webhook validation). Encrypted; never echoed back. */
export async function saveWebhookSecret(input: unknown): Promise<ActionResult> {
  const ctx = await admin();
  if (!ctx) return DENIED;
  const parsed = z.object({ integrationId: z.string().min(1), clientSecret: z.string().trim().min(6, "Paste the Recharge API client secret.") }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Please check the form.", fieldErrors: z.flattenError(parsed.error).fieldErrors };
  const r = await updateRechargeWebhookSecret(ctx, parsed.data.integrationId, parsed.data.clientSecret);
  if (r.ok) revalidatePath(`/settings/integrations/${parsed.data.integrationId}`);
  return r;
}

export async function registerWebhooks(input: unknown): Promise<ActionResult<{ endpoint: string; created: string[]; replaced: string[]; kept: string[] }>> {
  const ctx = await admin();
  if (!ctx) return DENIED;
  const parsed = z.object({ integrationId: z.string().min(1), baseUrl: z.string().trim().min(9, "Enter the public https base URL.") }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Please check the form.", fieldErrors: z.flattenError(parsed.error).fieldErrors };
  const r = await registerRechargeWebhooks(ctx, parsed.data.integrationId, parsed.data.baseUrl);
  if (r.ok) revalidatePath(`/settings/integrations/${parsed.data.integrationId}`);
  return r;
}

export async function unregisterWebhooks(integrationId: string): Promise<ActionResult<{ removed: number }>> {
  const ctx = await admin();
  if (!ctx) return DENIED;
  const r = await unregisterRechargeWebhooks(ctx, integrationId);
  if (r.ok) revalidatePath(`/settings/integrations/${integrationId}`);
  return r;
}

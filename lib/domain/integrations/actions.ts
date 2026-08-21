"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import { ForbiddenError, requireRole } from "@/lib/auth/tenancy";
import { encryptCredentials } from "@/lib/crypto/credentials";
import { logActivity } from "@/lib/domain/activity/log";
import { createRechargeConnectorFromCredentials } from "@/lib/integrations/recharge";
import { isRechargeError } from "@/lib/integrations/recharge/errors";
import { requiredCapabilitiesAvailable, type CapabilityMap, type ConnectorStore } from "@/lib/integrations/types";
import { getRechargeConnectorForIntegration } from "@/lib/domain/integrations/connector";
import { createSyncRun, SyncAlreadyRunningError } from "@/lib/domain/sync/progress";
import { inngest, integrationSyncRequested } from "@/lib/jobs/inngest";
import { logger } from "@/lib/logging/logger";
import type { ActionResult } from "@/lib/domain/organizations/actions";

const credentialsSchema = z.object({
  apiToken: z.string().trim().min(20, "Paste the full Recharge API token."),
  clientSecret: z.string().trim().min(10, "Paste the API client secret (used to verify webhooks).").optional().or(z.literal("")),
});

export type ConnectionTestResult = {
  store: ConnectorStore;
  capabilities: CapabilityMap;
  notes: string[];
  scopes: string[] | null;
  requiredOk: boolean;
};

function describeConnectorError(e: unknown): string {
  if (isRechargeError(e)) {
    switch (e.kind) {
      case "AUTHENTICATION_ERROR":
        return "Recharge rejected the API token. Check the token and that it has not been revoked.";
      case "PERMISSION_ERROR":
        return e.message;
      case "NETWORK_ERROR":
        return "Could not reach Recharge. Check your connection and try again.";
      case "RATE_LIMITED":
        return "Recharge is rate-limiting requests right now. Wait a moment and try again.";
      case "SCHEMA_ERROR":
        return "Recharge returned an unexpected response. Please try again; if it persists, contact support.";
      default:
        return e.message;
    }
  }
  return e instanceof Error ? e.message : "Unknown error";
}

/**
 * Test credentials WITHOUT saving anything: store identity + empirical capability
 * probe. Only GET requests; the premium Events/Credits endpoints are never called.
 */
export async function testRechargeConnection(input: unknown): Promise<ActionResult<ConnectionTestResult>> {
  try {
    await requireRole("ADMIN");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: e.message };
    throw e;
  }
  const parsed = credentialsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Please check the form.", fieldErrors: z.flattenError(parsed.error).fieldErrors };
  const connector = createRechargeConnectorFromCredentials({ apiToken: parsed.data.apiToken, clientSecret: parsed.data.clientSecret || null }, { correlationId: `test_${randomUUID().slice(0, 8)}` });
  try {
    const store = await connector.getStore();
    const report = await connector.probeCapabilities();
    return {
      ok: true,
      data: { store, capabilities: report.capabilities, notes: report.notes, scopes: report.scopes, requiredOk: requiredCapabilitiesAvailable(report.capabilities) },
    };
  } catch (e) {
    logger.warn("integration.test_failed", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: describeConnectorError(e) };
  }
}

/**
 * Connect Recharge for the current organisation:
 *   re-verify credentials (never trust the client's earlier test result) →
 *   encrypt with AAD = new integration id → save → log → queue INITIAL sync.
 */
export async function connectRecharge(input: unknown): Promise<ActionResult<{ integrationId: string; syncId: string }>> {
  let ctx;
  try {
    ctx = await requireRole("ADMIN");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: e.message };
    throw e;
  }
  const parsed = credentialsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Please check the form.", fieldErrors: z.flattenError(parsed.error).fieldErrors };
  const creds = { apiToken: parsed.data.apiToken, clientSecret: parsed.data.clientSecret || null };

  let store: ConnectorStore;
  let report;
  try {
    const connector = createRechargeConnectorFromCredentials(creds, { correlationId: `connect_${randomUUID().slice(0, 8)}` });
    store = await connector.getStore();
    report = await connector.probeCapabilities();
  } catch (e) {
    return { ok: false, error: describeConnectorError(e) };
  }
  if (!requiredCapabilitiesAvailable(report.capabilities)) {
    const missing = Object.entries(report.capabilities)
      .filter(([k, v]) => ["store", "customers", "products", "orders", "subscriptions", "onetimes", "webhooks"].includes(k) && (v === "unavailable" || v === "unknown"))
      .map(([k]) => k);
    return { ok: false, error: `The token is missing required access: ${missing.join(", ")}. Grant Customers, Products, Orders, Store information (view) and Subscriptions (view + manage), then try again.` };
  }

  const integrationId = randomUUID();
  const encrypted = encryptCredentials(creds, integrationId);
  const db = dbFor(ctx);
  try {
    await db.integration.create({
      data: {
        id: integrationId,
        organizationId: ctx.organizationId,
        provider: "RECHARGE",
        status: "CONNECTED",
        externalStoreId: store.externalStoreId,
        displayName: store.name,
        encryptedCredentials: encrypted,
        automationMode: "OFF",
        capabilitiesJson: report.capabilities,
        capabilitiesCheckedAt: report.checkedAt,
        settingsJson: { apiVersion: process.env.RECHARGE_API_VERSION ?? "2021-11", scopes: report.scopes, notes: report.notes, store },
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: `The Recharge store "${store.name}" is already connected to this organisation.` };
    }
    throw e;
  }
  await logActivity(ctx, {
    actorType: "USER",
    actorId: ctx.userId,
    eventType: "INTEGRATION_CONNECTED",
    entityType: "INTEGRATION",
    entityId: integrationId,
    summary: `Recharge connected — ${store.name}. All required capabilities available.${report.notes.length ? ` Notes: ${report.notes.length}.` : ""}`,
    metadata: { capabilities: report.capabilities, notes: report.notes },
  });

  const sync = await createSyncRun(ctx, integrationId, "INITIAL");
  await inngest.send(integrationSyncRequested.create({ syncId: sync.id, integrationId, organizationId: ctx.organizationId }));
  revalidatePath("/settings/integrations");
  revalidatePath("/");
  return { ok: true, data: { integrationId, syncId: sync.id } };
}

export async function requestSync(integrationId: string, kind: "INITIAL" | "INCREMENTAL" | "RECALCULATE_JOURNEYS" = "INCREMENTAL"): Promise<ActionResult<{ syncId: string }>> {
  let ctx;
  try {
    ctx = await requireRole("OPERATOR");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: e.message };
    throw e;
  }
  const db = dbFor(ctx);
  const integration = await db.integration.findUnique({ where: { id: integrationId }, select: { id: true, status: true, lastSuccessfulSyncAt: true, displayName: true } });
  if (!integration) return { ok: false, error: "Integration not found." };
  if (integration.status === "DISCONNECTED") return { ok: false, error: "This integration is disconnected." };
  try {
    const updatedSince = kind === "INCREMENTAL" && integration.lastSuccessfulSyncAt ? new Date(integration.lastSuccessfulSyncAt.getTime() - 10 * 60_000) : null;
    const sync = await createSyncRun(ctx, integrationId, kind, updatedSince);
    await inngest.send(integrationSyncRequested.create({ syncId: sync.id, integrationId, organizationId: ctx.organizationId }));
    await logActivity(ctx, { actorType: "USER", actorId: ctx.userId, eventType: "SYNC_REQUESTED", entityType: "INTEGRATION", entityId: integrationId, summary: `${kind === "INITIAL" ? "Full import" : kind === "INCREMENTAL" ? "Sync" : "Journey recalculation"} requested for ${integration.displayName}` });
    revalidatePath("/settings/integrations");
    revalidatePath(`/settings/integrations/${integrationId}`);
    return { ok: true, data: { syncId: sync.id } };
  } catch (e) {
    if (e instanceof SyncAlreadyRunningError) return { ok: false, error: e.message };
    throw e;
  }
}

export async function recheckCapabilities(integrationId: string): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireRole("OPERATOR");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: e.message };
    throw e;
  }
  try {
    const { connector } = await getRechargeConnectorForIntegration(ctx, integrationId);
    const report = await connector.probeCapabilities();
    await dbFor(ctx).integration.update({
      where: { id: integrationId },
      data: { capabilitiesJson: report.capabilities, capabilitiesCheckedAt: report.checkedAt, status: "CONNECTED", lastErrorAt: null, lastErrorMessage: null },
    });
    revalidatePath("/settings/integrations");
    revalidatePath(`/settings/integrations/${integrationId}`);
    return { ok: true };
  } catch (e) {
    const message = describeConnectorError(e);
    if (isRechargeError(e) && e.kind === "AUTHENTICATION_ERROR") {
      await dbFor(ctx).integration.update({ where: { id: integrationId }, data: { status: "ERROR", lastErrorAt: new Date(), lastErrorMessage: message } });
    }
    return { ok: false, error: message };
  }
}

/** Disconnect: status → DISCONNECTED and credentials wiped. Imported data is kept for history. */
export async function disconnectIntegration(integrationId: string): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireRole("ADMIN");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: e.message };
    throw e;
  }
  const db = dbFor(ctx);
  const integration = await db.integration.findUnique({ where: { id: integrationId }, select: { id: true, displayName: true } });
  if (!integration) return { ok: false, error: "Integration not found." };
  await db.integration.update({ where: { id: integrationId }, data: { status: "DISCONNECTED", encryptedCredentials: "", automationMode: "OFF" } });
  await db.integrationSync.updateMany({ where: { integrationId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED", finishedAt: new Date(), error: "Integration disconnected" } });
  await logActivity(ctx, { actorType: "USER", actorId: ctx.userId, eventType: "INTEGRATION_DISCONNECTED", entityType: "INTEGRATION", entityId: integrationId, summary: `Recharge disconnected — ${integration.displayName}. Credentials removed; imported data retained.` });
  revalidatePath("/settings/integrations");
  revalidatePath("/");
  return { ok: true };
}

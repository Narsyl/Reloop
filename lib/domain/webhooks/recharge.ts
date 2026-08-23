import "server-only";

/**
 * Recharge webhook registration + state (Phase 5).
 *
 * Registration is the ONLY non-GET Recharge surface on the platform and is allowlisted to
 * /webhooks paths inside the client itself. The webhook client secret lives in the integration's
 * encrypted credential blob ({ apiToken, clientSecret }) — never in settings JSON, activity
 * metadata, logs or the browser.
 */
import { Prisma } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import { decryptCredentials, encryptCredentials, hasDecryptionKeyFor } from "@/lib/crypto/credentials";
import { logActivity } from "@/lib/domain/activity/log";
import { getRechargeConnectorForIntegration, type StoredRechargeCredentials } from "@/lib/domain/integrations/connector";
import { PHASE5_WEBHOOK_TOPICS, type RegisteredWebhook } from "@/lib/integrations/recharge/webhooks";

type Ctx = { organizationId: string; userId?: string | null };
type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

export type WebhookSettings = { baseUrl: string; endpoint: string; topics: string[]; registeredAt: string } | null;

export function webhookEndpointPath(integrationId: string): string {
  return `/api/webhooks/recharge/${integrationId}`;
}

export type WebhookPanelState = {
  clientSecretConfigured: boolean;
  endpointPath: string;
  registration: WebhookSettings;
  /** live from Recharge (this token's API client); null when the API call failed */
  registered: RegisteredWebhook[] | null;
  registeredError: string | null;
  expectedTopics: readonly string[];
  latestReceived: { id: string; eventType: string; receivedAt: Date; signatureValid: boolean } | null;
  latestProcessed: { id: string; eventType: string; processedAt: Date | null } | null;
  health: { received24h: number; processed24h: number; failed24h: number; invalidSignature24h: number; pending: number };
};

export async function getWebhookPanelState(ctx: { organizationId: string }, integrationId: string): Promise<WebhookPanelState> {
  const db = dbFor(ctx);
  const integration = await db.integration.findUniqueOrThrow({ where: { id: integrationId }, select: { id: true, provider: true, encryptedCredentials: true, settingsJson: true } });
  let clientSecretConfigured = false;
  if (integration.encryptedCredentials && hasDecryptionKeyFor(integration.encryptedCredentials)) {
    try {
      const creds = decryptCredentials<StoredRechargeCredentials>(integration.encryptedCredentials, integration.id);
      clientSecretConfigured = typeof creds.clientSecret === "string" && creds.clientSecret.trim().length > 5;
    } catch {
      clientSecretConfigured = false;
    }
  }
  const settings = (integration.settingsJson as { webhooks?: WebhookSettings } | null)?.webhooks ?? null;
  let registered: RegisteredWebhook[] | null = null;
  let registeredError: string | null = null;
  try {
    const { connector } = await getRechargeConnectorForIntegration(ctx, integrationId, { correlationId: "wh_state" });
    registered = await connector.listWebhooks();
  } catch (e) {
    registeredError = e instanceof Error ? e.message.slice(0, 200) : String(e);
  }
  const since = new Date(Date.now() - 24 * 3600_000);
  const [latestReceived, latestProcessed, received24h, processed24h, failed24h, invalidSignature24h, pending] = await Promise.all([
    db.integrationEvent.findFirst({ where: { integrationId }, orderBy: { receivedAt: "desc" }, select: { id: true, eventType: true, receivedAt: true, signatureValid: true } }),
    db.integrationEvent.findFirst({ where: { integrationId, status: "PROCESSED" }, orderBy: { processedAt: "desc" }, select: { id: true, eventType: true, processedAt: true } }),
    db.integrationEvent.count({ where: { integrationId, receivedAt: { gte: since } } }),
    db.integrationEvent.count({ where: { integrationId, status: "PROCESSED", processedAt: { gte: since } } }),
    db.integrationEvent.count({ where: { integrationId, status: "FAILED", receivedAt: { gte: since } } }),
    db.integrationEvent.count({ where: { integrationId, signatureValid: false, receivedAt: { gte: since } } }),
    db.integrationEvent.count({ where: { integrationId, status: { in: ["RECEIVED", "PROCESSING"] } } }),
  ]);
  return {
    clientSecretConfigured,
    endpointPath: webhookEndpointPath(integrationId),
    registration: settings,
    registered,
    registeredError,
    expectedTopics: PHASE5_WEBHOOK_TOPICS,
    latestReceived,
    latestProcessed,
    health: { received24h, processed24h, failed24h, invalidSignature24h, pending },
  };
}

export async function listRecentWebhookEvents(ctx: { organizationId: string }, integrationId: string, take = 25) {
  return dbFor(ctx).integrationEvent.findMany({
    where: { integrationId },
    orderBy: { receivedAt: "desc" },
    take,
    select: { id: true, eventType: true, externalEventId: true, status: true, signatureValid: true, receivedAt: true, processedAt: true, attemptCount: true, lastError: true },
  });
}

/** Store/replace the webhook client secret inside the encrypted credential blob. Never logged or echoed. */
export async function updateRechargeWebhookSecret(ctx: Ctx, integrationId: string, clientSecret: string): Promise<Result> {
  const db = dbFor(ctx);
  const integration = await db.integration.findUnique({ where: { id: integrationId }, select: { id: true, provider: true, displayName: true, encryptedCredentials: true } });
  if (!integration || integration.provider !== "RECHARGE") return { ok: false, error: "Recharge integration not found." };
  if (!integration.encryptedCredentials || !hasDecryptionKeyFor(integration.encryptedCredentials)) return { ok: false, error: "The integration's credentials cannot be opened on this host." };
  const secret = clientSecret.trim();
  if (secret.length < 6) return { ok: false, error: "Paste the Recharge API client secret." };
  const creds = decryptCredentials<StoredRechargeCredentials>(integration.encryptedCredentials, integration.id);
  const replaced = !!creds.clientSecret;
  await db.integration.update({ where: { id: integration.id }, data: { encryptedCredentials: encryptCredentials({ ...creds, clientSecret: secret }, integration.id) } });
  await logActivity(ctx, {
    actorType: ctx.userId ? "USER" : "SYSTEM",
    actorId: ctx.userId ?? null,
    eventType: "WEBHOOK_SECRET_UPDATED",
    entityType: "INTEGRATION",
    entityId: integration.id,
    summary: `Webhook client secret ${replaced ? "replaced" : "configured"} for ${integration.displayName} (stored encrypted; used to validate X-Recharge-Hmac-Sha256).`,
  });
  return { ok: true };
}

/**
 * Ensure exactly the Phase 5 topics are registered, pointing at
 * `${baseUrl}/api/webhooks/recharge/{integrationId}`. Existing rows for our topics with a different
 * address are replaced (webhooks listed here belong to this token's API client). Other topics are
 * left untouched.
 */
export async function registerRechargeWebhooks(ctx: Ctx, integrationId: string, baseUrl: string): Promise<Result<{ endpoint: string; created: string[]; replaced: string[]; kept: string[] }>> {
  const db = dbFor(ctx);
  const cleanBase = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^\s]+$/i.test(cleanBase)) return { ok: false, error: "Enter the public https base URL of this platform (Recharge only delivers to https)." };
  const endpoint = `${cleanBase}${webhookEndpointPath(integrationId)}`;
  let connector;
  try {
    connector = (await getRechargeConnectorForIntegration(ctx, integrationId, { correlationId: "wh_register" })).connector;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  try {
    const existing = await connector.listWebhooks();
    const created: string[] = [];
    const replaced: string[] = [];
    const kept: string[] = [];
    for (const topic of PHASE5_WEBHOOK_TOPICS) {
      const matches = existing.filter((w) => w.topic === topic);
      const good = matches.find((w) => w.address === endpoint);
      if (good) {
        kept.push(topic);
        for (const stale of matches.filter((w) => w.id !== good.id)) await connector.deleteWebhook(stale.id);
        continue;
      }
      for (const stale of matches) {
        await connector.deleteWebhook(stale.id);
        replaced.push(`${topic} (was ${stale.address})`);
      }
      await connector.createWebhook({ address: endpoint, topic });
      created.push(topic);
    }
    const settingsRow = await db.integration.findUniqueOrThrow({ where: { id: integrationId }, select: { settingsJson: true, displayName: true } });
    const settings = (settingsRow.settingsJson as Record<string, unknown> | null) ?? {};
    await db.integration.update({
      where: { id: integrationId },
      data: { settingsJson: { ...settings, webhooks: { baseUrl: cleanBase, endpoint, topics: [...PHASE5_WEBHOOK_TOPICS], registeredAt: new Date().toISOString() } } as unknown as Prisma.InputJsonValue },
    });
    await logActivity(ctx, {
      actorType: ctx.userId ? "USER" : "SYSTEM",
      actorId: ctx.userId ?? null,
      eventType: "WEBHOOKS_REGISTERED",
      entityType: "INTEGRATION",
      entityId: integrationId,
      summary: `Recharge webhooks registered at ${endpoint}: ${PHASE5_WEBHOOK_TOPICS.join(", ")} (${created.length} created, ${kept.length} already correct${replaced.length ? `, ${replaced.length} re-pointed` : ""}). Payloads are signals only — processing re-reads Recharge and feeds the existing sync code.`,
      metadata: { endpoint, created, kept, replaced },
    });
    return { ok: true, data: { endpoint, created, replaced, kept } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Remove the Phase 5 topics that point at OUR endpoint(s). Leaves anything else alone. */
export async function unregisterRechargeWebhooks(ctx: Ctx, integrationId: string): Promise<Result<{ removed: number }>> {
  const db = dbFor(ctx);
  try {
    const { connector } = await getRechargeConnectorForIntegration(ctx, integrationId, { correlationId: "wh_unregister" });
    const suffix = webhookEndpointPath(integrationId);
    const existing = await connector.listWebhooks();
    let removed = 0;
    for (const w of existing) {
      if ((PHASE5_WEBHOOK_TOPICS as readonly string[]).includes(w.topic) && w.address.endsWith(suffix)) {
        await connector.deleteWebhook(w.id);
        removed++;
      }
    }
    const settingsRow = await db.integration.findUniqueOrThrow({ where: { id: integrationId }, select: { settingsJson: true } });
    const settings = (settingsRow.settingsJson as Record<string, unknown> | null) ?? {};
    delete settings.webhooks;
    await db.integration.update({ where: { id: integrationId }, data: { settingsJson: settings as unknown as Prisma.InputJsonValue } });
    await logActivity(ctx, { actorType: ctx.userId ? "USER" : "SYSTEM", actorId: ctx.userId ?? null, eventType: "WEBHOOKS_UNREGISTERED", entityType: "INTEGRATION", entityId: integrationId, summary: `Recharge webhooks unregistered (${removed} removed). The incremental cron remains the reconciliation backstop.`, metadata: { removed } });
    return { ok: true, data: { removed } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

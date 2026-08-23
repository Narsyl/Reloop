/**
 * Shopify integration (revised Phase 4c) — domain side. READ-ONLY catalogue access used to bind physical
 * reward items to their existing Shopify variants; paired with the Recharge integration whose one-times
 * will reference those variants.
 *
 * Credentials (durable): Client ID + Client secret from the Shopify Dev Dashboard app, encrypted per
 * integration (AAD = integration id) exactly like Recharge. The short-lived Admin API access token is
 * exchanged server-side (client-credentials grant), cached encrypted on the Integration row
 * (`encryptedAccessToken` / `accessTokenExpiresAt`, AAD = "<id>:token") and refreshed automatically.
 * `authMode` is recorded so merchant OAuth can be added later without touching callers.
 *
 * Neither the client secret nor the access token is ever returned to the browser, logged, put into
 * Inngest payloads or written to ActivityLog metadata — only a Client ID hint ("abcd…wxyz").
 */
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { dbFor } from "@/lib/db/tenant";
import { decryptCredentials, encryptCredentials } from "@/lib/crypto/credentials";
import { logActivity } from "@/lib/domain/activity/log";
import { createShopifyConnectorFromCredentials, exchangeClientCredentials, isShopifyError, normalizeShopDomain, SHOPIFY_API_VERSION, type ShopifyAuthMode, type ShopifyCapabilityReport, type ShopifyConnector, type ShopifyCredentials, type ShopifyTokenCacheStore } from "@/lib/integrations/shopify";
import { IntegrationUnavailableError } from "./connector";

type Ctx = { organizationId: string; userId?: string | null };
type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

export type ShopifyIntegrationSettings = {
  shopDomain: string;
  apiVersion: string;
  authMode: ShopifyAuthMode;
  /** "abcd…wxyz" — never the full client id */
  clientIdHint: string | null;
  grantedScopes: string[];
  onlineStorePublicationId: string | null;
  store: ShopifyCapabilityReport["store"];
};

export function clientIdHint(clientId: string): string {
  const c = clientId.trim();
  if (c.length <= 8) return `${c.slice(0, 2)}…`;
  return `${c.slice(0, 4)}…${c.slice(-4)}`;
}

export function describeShopifyError(e: unknown): string {
  if (isShopifyError(e)) {
    switch (e.kind) {
      case "AUTHENTICATION_ERROR":
        return e.message.includes("client credentials") ? e.message : "Shopify rejected the app credentials. Check the Client ID / Client secret (Dev Dashboard → your app → Settings) and that the app is installed on this store.";
      case "PERMISSION_ERROR":
        return "The Shopify app lacks the read_products scope. Grant read_products (read_publications optional), reinstall the app and try again.";
      case "NOT_FOUND":
        return "Shopify did not recognise the shop domain or API version. Use the myshopify.com domain (e.g. your-store.myshopify.com).";
      case "RATE_LIMITED":
        return "Shopify is rate-limiting requests right now; try again in a moment.";
      case "NETWORK_ERROR":
        return "Could not reach Shopify. Check the shop domain and your connection.";
      case "FORBIDDEN_OPERATION":
        return "Refused: the Shopify connector is read-only.";
      default:
        return `Shopify: ${e.message}`;
    }
  }
  return e instanceof Error ? e.message : String(e);
}

const TOKEN_AAD = (integrationId: string) => `${integrationId}:token`;

/** Encrypted, row-backed token cache shared by every process (web, jobs). */
function dbTokenCache(ctx: { organizationId: string }, integrationId: string): ShopifyTokenCacheStore {
  const db = dbFor(ctx);
  return {
    async load() {
      const row = await db.integration.findUnique({ where: { id: integrationId }, select: { encryptedAccessToken: true, accessTokenExpiresAt: true } });
      if (!row?.encryptedAccessToken) return null;
      try {
        const t = decryptCredentials<{ accessToken: string; scope?: string[] }>(row.encryptedAccessToken, TOKEN_AAD(integrationId));
        return { accessToken: t.accessToken, expiresAt: row.accessTokenExpiresAt, scope: t.scope ?? [] };
      } catch {
        return null; // undecryptable cache → just refresh
      }
    },
    async save(t) {
      await db.integration.update({ where: { id: integrationId }, data: { encryptedAccessToken: encryptCredentials({ accessToken: t.accessToken, scope: t.scope }, TOKEN_AAD(integrationId)), accessTokenExpiresAt: t.expiresAt } });
    },
    async clear() {
      await db.integration.update({ where: { id: integrationId }, data: { encryptedAccessToken: null, accessTokenExpiresAt: null } });
    },
  };
}

/** Test client credentials without saving anything: exchange → store identity → read_products probe. */
export async function testShopifyCredentials(creds: { shopDomain: string; clientId: string; clientSecret: string }): Promise<Result<ShopifyCapabilityReport>> {
  try {
    const shopDomain = normalizeShopDomain(creds.shopDomain);
    const token = await exchangeClientCredentials({ shopDomain, clientId: creds.clientId, clientSecret: creds.clientSecret });
    const connector = createShopifyConnectorFromCredentials({ authMode: "ACCESS_TOKEN", shopDomain, accessToken: token.accessToken }, { correlationId: `shp_test_${randomUUID().slice(0, 8)}` });
    const report = await connector.probeCapabilities({ tokenScopes: token.scope });
    return { ok: true, data: { ...report, authMode: "CLIENT_CREDENTIALS", tokenExpiresAt: token.expiresAt?.toISOString() ?? null } };
  } catch (e) {
    return { ok: false, error: describeShopifyError(e) };
  }
}

/** Connect (or re-connect) a Shopify store, paired with a Recharge integration of the same organisation. */
export async function connectShopifyIntegration(ctx: Ctx, input: { shopDomain: string; clientId: string; clientSecret: string; pairedIntegrationId: string | null; displayName?: string | null }): Promise<Result<{ integrationId: string; report: ShopifyCapabilityReport }>> {
  const db = dbFor(ctx);
  let shopDomain: string;
  try {
    shopDomain = normalizeShopDomain(input.shopDomain);
  } catch (e) {
    return { ok: false, error: describeShopifyError(e) };
  }
  const clientId = input.clientId.trim();
  const clientSecret = input.clientSecret.trim();
  if (!clientId || !clientSecret) return { ok: false, error: "Enter the app's Client ID and Client secret." };
  if (input.pairedIntegrationId) {
    const paired = await db.integration.findUnique({ where: { id: input.pairedIntegrationId }, select: { id: true, provider: true } });
    if (!paired || paired.provider !== "RECHARGE") return { ok: false, error: "The Shopify store must be paired with a Recharge integration of this organisation." };
  }
  // exchange + probe with the candidate credentials (nothing saved yet)
  let report: ShopifyCapabilityReport;
  let token;
  try {
    token = await exchangeClientCredentials({ shopDomain, clientId, clientSecret });
    const probeConnector = createShopifyConnectorFromCredentials({ authMode: "ACCESS_TOKEN", shopDomain, accessToken: token.accessToken }, { correlationId: `shp_connect_${randomUUID().slice(0, 8)}` });
    report = { ...(await probeConnector.probeCapabilities({ tokenScopes: token.scope })), authMode: "CLIENT_CREDENTIALS", tokenExpiresAt: token.expiresAt?.toISOString() ?? null };
  } catch (e) {
    return { ok: false, error: describeShopifyError(e) };
  }
  if (!report.requiredOk) {
    return { ok: false, error: `Shopify answered, but the app cannot read products (missing: ${report.missingScopes.join(", ") || "read_products"}). Grant read_products in the Dev Dashboard, reinstall the app and test again. Nothing was saved.` };
  }
  const creds: ShopifyCredentials = { authMode: "CLIENT_CREDENTIALS", shopDomain, clientId, clientSecret };
  const settings: ShopifyIntegrationSettings = { shopDomain, apiVersion: SHOPIFY_API_VERSION, authMode: "CLIENT_CREDENTIALS", clientIdHint: clientIdHint(clientId), grantedScopes: report.grantedScopes, onlineStorePublicationId: report.onlineStorePublicationId, store: report.store };
  const existing = await db.integration.findFirst({ where: { provider: "SHOPIFY", externalStoreId: shopDomain }, select: { id: true } });
  const integrationId = existing?.id ?? randomUUID();
  const encrypted = encryptCredentials(creds, integrationId);
  const tokenBlob = encryptCredentials({ accessToken: token.accessToken, scope: token.scope }, TOKEN_AAD(integrationId));
  const common = {
    status: "CONNECTED" as const,
    displayName: input.displayName?.trim() || `${report.store.name} (Shopify)`,
    encryptedCredentials: encrypted,
    encryptedAccessToken: tokenBlob,
    accessTokenExpiresAt: token.expiresAt,
    capabilitiesJson: report as unknown as Prisma.InputJsonValue,
    capabilitiesCheckedAt: new Date(report.checkedAt),
    settingsJson: settings as unknown as Prisma.InputJsonValue,
    pairedIntegrationId: input.pairedIntegrationId,
    lastErrorAt: null,
    lastErrorMessage: null,
  };
  try {
    if (existing) await db.integration.update({ where: { id: existing.id }, data: common });
    else await db.integration.create({ data: { id: integrationId, organizationId: ctx.organizationId, provider: "SHOPIFY", externalStoreId: shopDomain, automationMode: "OFF", ...common } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, error: `The Shopify store ${shopDomain} is already connected to this organisation.` };
    throw e;
  }
  await logActivity(ctx, {
    actorType: ctx.userId ? "USER" : "SYSTEM",
    actorId: ctx.userId ?? null,
    eventType: existing ? "INTEGRATION_RECONNECTED" : "INTEGRATION_CONNECTED",
    entityType: "INTEGRATION",
    entityId: integrationId,
    summary: `Shopify ${existing ? "re-" : ""}connected (read-only, client credentials, Client ID ${settings.clientIdHint}) — ${report.store.name} (${shopDomain}). Scopes: ${report.grantedScopes.join(", ")}.${report.unexpectedScopes.length ? ` Unused extra scopes granted: ${report.unexpectedScopes.join(", ")}.` : ""} Orders/customers/fulfilments/writes never requested.`,
    metadata: { authMode: "CLIENT_CREDENTIALS", clientIdHint: settings.clientIdHint, grantedScopes: report.grantedScopes, unexpectedScopes: report.unexpectedScopes, pairedIntegrationId: input.pairedIntegrationId },
  });
  return { ok: true, data: { integrationId, report } };
}

export async function recheckShopifyIntegration(ctx: Ctx, integrationId: string): Promise<Result<ShopifyCapabilityReport>> {
  const db = dbFor(ctx);
  try {
    const { connector, settings } = await getShopifyConnectorForIntegration(ctx, integrationId, { correlationId: `shp_recheck_${integrationId.slice(-6)}` });
    const report = await connector.probeCapabilities();
    await db.integration.update({ where: { id: integrationId }, data: { capabilitiesJson: report as unknown as Prisma.InputJsonValue, capabilitiesCheckedAt: new Date(report.checkedAt), settingsJson: { ...settings, onlineStorePublicationId: report.onlineStorePublicationId, grantedScopes: report.grantedScopes, store: report.store } as unknown as Prisma.InputJsonValue, status: "CONNECTED", lastErrorAt: null, lastErrorMessage: null } });
    return { ok: true, data: report };
  } catch (e) {
    const msg = describeShopifyError(e);
    await db.integration.update({ where: { id: integrationId }, data: { lastErrorAt: new Date(), lastErrorMessage: msg.slice(0, 500), ...(isShopifyError(e) && e.kind === "AUTHENTICATION_ERROR" ? { status: "ERROR" } : {}) } }).catch(() => undefined);
    return { ok: false, error: msg };
  }
}

export async function getShopifyConnectorForIntegration(ctx: { organizationId: string }, integrationId: string, opts: { correlationId?: string } = {}): Promise<{ connector: ShopifyConnector; settings: ShopifyIntegrationSettings; integration: { id: string; displayName: string; pairedIntegrationId: string | null } }> {
  const db = dbFor(ctx);
  const integration = await db.integration.findUnique({ where: { id: integrationId }, select: { id: true, provider: true, status: true, displayName: true, encryptedCredentials: true, settingsJson: true, pairedIntegrationId: true } });
  if (!integration) throw new IntegrationUnavailableError("Shopify integration not found in this organisation.");
  if (integration.provider !== "SHOPIFY") throw new IntegrationUnavailableError("Integration is not a Shopify integration.");
  if (integration.status === "DISCONNECTED" || !integration.encryptedCredentials) throw new IntegrationUnavailableError("Shopify integration is disconnected; reconnect it to continue.");
  const creds = decryptCredentials<ShopifyCredentials>(integration.encryptedCredentials, integration.id);
  const stored = integration.settingsJson as Partial<ShopifyIntegrationSettings> | null;
  const settings: ShopifyIntegrationSettings = {
    shopDomain: stored?.shopDomain ?? creds.shopDomain,
    apiVersion: stored?.apiVersion ?? SHOPIFY_API_VERSION,
    authMode: creds.authMode,
    clientIdHint: stored?.clientIdHint ?? (creds.authMode === "CLIENT_CREDENTIALS" ? clientIdHint(creds.clientId) : null),
    grantedScopes: stored?.grantedScopes ?? [],
    onlineStorePublicationId: stored?.onlineStorePublicationId ?? null,
    store: stored?.store ?? { shopGid: "", name: integration.displayName, myshopifyDomain: creds.shopDomain, primaryDomainHost: null, currencyCode: "", planDisplayName: null, ianaTimezone: null },
  };
  const connector = createShopifyConnectorFromCredentials(creds, { apiVersion: settings.apiVersion, correlationId: opts.correlationId, onlineStorePublicationId: settings.onlineStorePublicationId, tokenCache: creds.authMode === "CLIENT_CREDENTIALS" ? dbTokenCache(ctx, integration.id) : undefined });
  return { connector, settings, integration: { id: integration.id, displayName: integration.displayName, pairedIntegrationId: integration.pairedIntegrationId } };
}

/** The Shopify integration serving a Recharge store (pairing), if any. */
export async function findShopifyIntegrationForRecharge(ctx: { organizationId: string }, rechargeIntegrationId: string) {
  return dbFor(ctx).integration.findFirst({ where: { provider: "SHOPIFY", pairedIntegrationId: rechargeIntegrationId, status: { not: "DISCONNECTED" } }, select: { id: true, displayName: true, status: true, settingsJson: true, capabilitiesJson: true, capabilitiesCheckedAt: true } });
}

/** Connected Shopify integrations of the organisation (for binding UIs). */
export async function listShopifyIntegrations(ctx: { organizationId: string }) {
  return dbFor(ctx).integration.findMany({ where: { provider: "SHOPIFY", status: { not: "DISCONNECTED" } }, select: { id: true, displayName: true, status: true, externalStoreId: true, pairedIntegrationId: true, settingsJson: true, capabilitiesCheckedAt: true, accessTokenExpiresAt: true }, orderBy: { createdAt: "asc" } });
}

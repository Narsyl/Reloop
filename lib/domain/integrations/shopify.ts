/**
 * Shopify integration (Phase 4c) — domain side. Catalogue + fulfilment-marker identity/verification
 * only; paired with the Recharge integration whose one-times will reference the Shopify variants.
 *
 * Credentials: custom-app Admin API access token today, encrypted per integration (AAD = integration id)
 * exactly like Recharge; an OAuth-issued token later uses the same stored shape.
 */
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { dbFor } from "@/lib/db/tenant";
import { decryptCredentials, encryptCredentials } from "@/lib/crypto/credentials";
import { logActivity } from "@/lib/domain/activity/log";
import { createShopifyConnectorFromCredentials, isShopifyError, normalizeShopDomain, SHOPIFY_API_VERSION, type ShopifyCapabilityReport, type ShopifyConnector, type ShopifyCredentials } from "@/lib/integrations/shopify";
import { IntegrationUnavailableError } from "./connector";

type Ctx = { organizationId: string; userId?: string | null };
type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

export type ShopifyIntegrationSettings = {
  shopDomain: string;
  apiVersion: string;
  onlineStorePublicationId: string | null;
  grantedScopes: string[];
  store: ShopifyCapabilityReport["store"];
};

export function describeShopifyError(e: unknown): string {
  if (isShopifyError(e)) {
    switch (e.kind) {
      case "AUTHENTICATION_ERROR":
        return "Shopify rejected the access token. Check the custom app's Admin API access token (it starts with shpat_) and that the app is installed on this store.";
      case "PERMISSION_ERROR":
        return "The Shopify app lacks a required scope. Grant read_products, write_products, read_publications and write_publications, then reinstall the app and try again.";
      case "NOT_FOUND":
        return "Shopify did not recognise the shop domain or API version. Use the myshopify.com domain (e.g. your-store.myshopify.com).";
      case "RATE_LIMITED":
        return "Shopify is rate-limiting requests right now; try again in a moment.";
      case "NETWORK_ERROR":
        return "Could not reach Shopify. Check the shop domain and your connection.";
      default:
        return `Shopify: ${e.message}`;
    }
  }
  return e instanceof Error ? e.message : String(e);
}

/** Test credentials without saving anything. */
export async function testShopifyCredentials(creds: { shopDomain: string; accessToken: string }): Promise<Result<ShopifyCapabilityReport>> {
  try {
    const shopDomain = normalizeShopDomain(creds.shopDomain);
    const connector = createShopifyConnectorFromCredentials({ shopDomain, accessToken: creds.accessToken.trim() }, { correlationId: `shp_test_${randomUUID().slice(0, 8)}` });
    const report = await connector.probeCapabilities();
    return { ok: true, data: report };
  } catch (e) {
    return { ok: false, error: describeShopifyError(e) };
  }
}

/** Connect (or re-connect) a Shopify store, paired with a Recharge integration of the same organisation. */
export async function connectShopifyIntegration(ctx: Ctx, input: { shopDomain: string; accessToken: string; pairedIntegrationId: string | null; displayName?: string | null }): Promise<Result<{ integrationId: string; report: ShopifyCapabilityReport }>> {
  const db = dbFor(ctx);
  let shopDomain: string;
  try {
    shopDomain = normalizeShopDomain(input.shopDomain);
  } catch (e) {
    return { ok: false, error: describeShopifyError(e) };
  }
  if (input.pairedIntegrationId) {
    const paired = await db.integration.findUnique({ where: { id: input.pairedIntegrationId }, select: { id: true, provider: true } });
    if (!paired || paired.provider !== "RECHARGE") return { ok: false, error: "The Shopify store must be paired with a Recharge integration of this organisation." };
  }
  const creds: ShopifyCredentials = { shopDomain, accessToken: input.accessToken.trim() };
  let report: ShopifyCapabilityReport;
  try {
    report = await createShopifyConnectorFromCredentials(creds, { correlationId: `shp_connect_${randomUUID().slice(0, 8)}` }).probeCapabilities();
  } catch (e) {
    return { ok: false, error: describeShopifyError(e) };
  }
  if (!report.requiredOk) {
    const why = [...(report.missingScopes.length ? [`missing scopes: ${report.missingScopes.join(", ")}`] : []), ...(report.onlineStorePublicationId ? [] : ["the Online Store sales channel could not be found"])].join("; ");
    return { ok: false, error: `Shopify connected, but it is not usable for markers yet — ${why}. Least privilege: only read/write products and read/write publications are required.` };
  }
  const settings: ShopifyIntegrationSettings = { shopDomain, apiVersion: SHOPIFY_API_VERSION, onlineStorePublicationId: report.onlineStorePublicationId, grantedScopes: report.grantedScopes, store: report.store };
  const existing = await db.integration.findFirst({ where: { provider: "SHOPIFY", externalStoreId: shopDomain }, select: { id: true, status: true } });
  const integrationId = existing?.id ?? randomUUID();
  const encrypted = encryptCredentials(creds, integrationId);
  try {
    if (existing) {
      await db.integration.update({ where: { id: existing.id }, data: { status: "CONNECTED", displayName: input.displayName?.trim() || `${report.store.name} (Shopify)`, encryptedCredentials: encrypted, capabilitiesJson: report as unknown as Prisma.InputJsonValue, capabilitiesCheckedAt: new Date(report.checkedAt), settingsJson: settings as unknown as Prisma.InputJsonValue, pairedIntegrationId: input.pairedIntegrationId, lastErrorAt: null, lastErrorMessage: null } });
    } else {
      await db.integration.create({
        data: {
          id: integrationId,
          organizationId: ctx.organizationId,
          provider: "SHOPIFY",
          status: "CONNECTED",
          externalStoreId: shopDomain,
          displayName: input.displayName?.trim() || `${report.store.name} (Shopify)`,
          encryptedCredentials: encrypted,
          automationMode: "OFF", // not applicable to Shopify; never anything else
          capabilitiesJson: report as unknown as Prisma.InputJsonValue,
          capabilitiesCheckedAt: new Date(report.checkedAt),
          settingsJson: settings as unknown as Prisma.InputJsonValue,
          pairedIntegrationId: input.pairedIntegrationId,
        },
      });
    }
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
    summary: `Shopify ${existing ? "re-" : ""}connected — ${report.store.name} (${shopDomain}). Scopes: ${report.grantedScopes.join(", ")}. Catalogue + fulfilment-marker identity only; orders/customers/fulfilments not requested.${report.unexpectedScopes.length ? ` Unexpected extra scopes granted (unused): ${report.unexpectedScopes.join(", ")}.` : ""}`,
    metadata: { grantedScopes: report.grantedScopes, unexpectedScopes: report.unexpectedScopes, onlineStorePublicationId: report.onlineStorePublicationId, pairedIntegrationId: input.pairedIntegrationId },
  });
  return { ok: true, data: { integrationId, report } };
}

export async function recheckShopifyIntegration(ctx: Ctx, integrationId: string): Promise<Result<ShopifyCapabilityReport>> {
  const db = dbFor(ctx);
  try {
    const { connector, settings } = await getShopifyConnectorForIntegration(ctx, integrationId);
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
  const settings = (integration.settingsJson as ShopifyIntegrationSettings | null) ?? { shopDomain: creds.shopDomain, apiVersion: SHOPIFY_API_VERSION, onlineStorePublicationId: null, grantedScopes: [], store: { shopGid: "", name: integration.displayName, myshopifyDomain: creds.shopDomain, primaryDomainHost: null, currencyCode: "", planDisplayName: null, ianaTimezone: null } };
  const connector = createShopifyConnectorFromCredentials(creds, { apiVersion: settings.apiVersion, correlationId: opts.correlationId, onlineStorePublicationId: settings.onlineStorePublicationId });
  return { connector, settings, integration: { id: integration.id, displayName: integration.displayName, pairedIntegrationId: integration.pairedIntegrationId } };
}

/** The Shopify integration serving a Recharge store (pairing), if any. */
export async function findShopifyIntegrationForRecharge(ctx: { organizationId: string }, rechargeIntegrationId: string) {
  return dbFor(ctx).integration.findFirst({ where: { provider: "SHOPIFY", pairedIntegrationId: rechargeIntegrationId, status: { not: "DISCONNECTED" } }, select: { id: true, displayName: true, status: true, settingsJson: true, capabilitiesJson: true, capabilitiesCheckedAt: true } });
}

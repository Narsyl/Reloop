import "server-only";
import { dbFor } from "@/lib/db/tenant";
import { decryptCredentials } from "@/lib/crypto/credentials";
import { createRechargeConnector, RechargeClient, type RechargeConnector } from "@/lib/integrations/recharge";
import { logger } from "@/lib/logging/logger";

export type StoredRechargeCredentials = { apiToken: string; clientSecret: string | null };

export class IntegrationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationUnavailableError";
  }
}

/**
 * Build a Recharge connector for ONE integration of ONE organisation.
 *
 * Credentials are selected explicitly (the column is omitted from default
 * selects), decrypted in memory with AAD = integration id, and handed straight
 * to the client. There is no fallback to any environment token: tenant runtime
 * behaviour always uses the Integration's own credentials.
 */
export async function getRechargeConnectorForIntegration(
  ctx: { organizationId: string },
  integrationId: string,
  opts: { correlationId?: string } = {},
): Promise<{ connector: RechargeConnector; integration: { id: string; organizationId: string; status: string; displayName: string; externalStoreId: string } }> {
  const db = dbFor(ctx);
  const integration = await db.integration.findUnique({
    where: { id: integrationId },
    select: { id: true, organizationId: true, status: true, displayName: true, externalStoreId: true, provider: true, encryptedCredentials: true },
  });
  if (!integration) throw new IntegrationUnavailableError("Integration not found in this organisation.");
  if (integration.provider !== "RECHARGE") throw new IntegrationUnavailableError("Integration is not a Recharge integration.");
  if (integration.status === "DISCONNECTED" || !integration.encryptedCredentials) {
    throw new IntegrationUnavailableError("Integration is disconnected; reconnect it to continue.");
  }
  const credentials = decryptCredentials<StoredRechargeCredentials>(integration.encryptedCredentials, integration.id);
  const client = new RechargeClient({
    credentials: { apiToken: credentials.apiToken, clientSecret: credentials.clientSecret },
    correlationId: opts.correlationId,
    log: logger.child({ connector: "recharge", organizationId: ctx.organizationId, integrationId, correlationId: opts.correlationId }),
  });
  const { encryptedCredentials: _omit, ...safe } = integration;
  void _omit;
  return { connector: createRechargeConnector(client), integration: safe };
}

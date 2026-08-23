/**
 * Shopify authentication — client-credentials grant + token caching.
 *
 *   POST https://{shop}/admin/oauth/access_token
 *   { client_id, client_secret, grant_type: "client_credentials" }
 *   → { access_token, scope, expires_in }   (≈ 24 h)
 *
 * `ClientCredentialsTokenProvider.getAccessToken()` returns a cached token while it is comfortably valid
 * (refresh margin below), otherwise exchanges the client credentials again, records the new expiry and
 * persists it through the optional cache store (the domain layer encrypts it). A 401 on a GraphQL call
 * makes the client call `getAccessToken({ forceRefresh: true })` once.
 *
 * The client secret never leaves this process except in the exchange request body; it is never logged.
 */
import { ShopifyError } from "./errors";
import { logger, type Logger } from "@/lib/logging/logger";
import type { ShopifyAccessToken, ShopifyCredentials, ShopifyTokenCacheStore, ShopifyTokenProvider } from "./types";

/** Refresh when less than this remains (tokens last ~86,399 s; plenty of room). */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export function normalizeShopDomain(input: string): string {
  const d = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(d)) throw new ShopifyError("VALIDATION_ERROR", `"${input}" is not a myshopify.com domain (expected e.g. your-store.myshopify.com)`);
  return d;
}

export function tokenEndpoint(shopDomain: string): string {
  return `https://${normalizeShopDomain(shopDomain)}/admin/oauth/access_token`;
}

/** One exchange. Throws ShopifyError(AUTHENTICATION_ERROR | NETWORK_ERROR | REMOTE_SERVER_ERROR | SCHEMA_ERROR). */
export async function exchangeClientCredentials(input: { shopDomain: string; clientId: string; clientSecret: string }, opts: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => Date; log?: Logger } = {}): Promise<ShopifyAccessToken> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? logger.child({ connector: "shopify", shop: input.shopDomain });
  if (!input.clientId.trim() || !input.clientSecret.trim()) throw new ShopifyError("AUTHENTICATION_ERROR", "Shopify client id / client secret are missing");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  let response: Response;
  try {
    response = await fetchImpl(tokenEndpoint(input.shopDomain), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: input.clientId.trim(), client_secret: input.clientSecret.trim(), grant_type: "client_credentials" }),
      signal: controller.signal,
    });
  } catch (e) {
    throw new ShopifyError("NETWORK_ERROR", `Could not reach Shopify to exchange client credentials: ${String((e as Error)?.message ?? e)}`, { cause: e });
  } finally {
    clearTimeout(timer);
  }
  const requestId = response.headers.get("x-request-id") ?? undefined;
  if (response.status === 401 || response.status === 400 || response.status === 403) {
    let detail = "";
    try {
      const j = (await response.json()) as { error?: string; error_description?: string; errors?: unknown };
      detail = j.error_description ?? j.error ?? (typeof j.errors === "string" ? j.errors : "");
    } catch {
      /* ignore body */
    }
    throw new ShopifyError("AUTHENTICATION_ERROR", `Shopify rejected the client credentials (${response.status})${detail ? `: ${detail}` : ""}. Check the Client ID / Client secret from the Dev Dashboard and that the app is installed on ${input.shopDomain}.`, { status: response.status, requestId });
  }
  if (response.status === 404) throw new ShopifyError("NOT_FOUND", `Shopify did not recognise ${input.shopDomain} (404) — check the myshopify.com domain.`, { status: 404, requestId });
  if (response.status >= 500) throw new ShopifyError("REMOTE_SERVER_ERROR", `Shopify token endpoint returned ${response.status}`, { status: response.status, requestId });
  if (!response.ok) throw new ShopifyError("UNKNOWN", `Shopify token endpoint returned ${response.status}`, { status: response.status, requestId });
  let body: { access_token?: unknown; scope?: unknown; expires_in?: unknown };
  try {
    body = (await response.json()) as typeof body;
  } catch (e) {
    throw new ShopifyError("SCHEMA_ERROR", "Shopify token endpoint returned non-JSON", { requestId, cause: e });
  }
  if (typeof body.access_token !== "string" || !body.access_token) throw new ShopifyError("SCHEMA_ERROR", "Shopify token response has no access_token", { requestId });
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : typeof body.expires_in === "string" ? Number(body.expires_in) : NaN;
  const expiresAt = Number.isFinite(expiresIn) ? new Date(now().getTime() + expiresIn * 1000) : null;
  const scope = typeof body.scope === "string" ? body.scope.split(",").map((s) => s.trim()).filter(Boolean).sort() : [];
  log.info("shopify.token_exchanged", { expiresAt: expiresAt?.toISOString() ?? null, scopes: scope.length, requestId });
  return { accessToken: body.access_token, scope, expiresAt };
}

/** Token for credentials issued elsewhere (tests, future OAuth). Never refreshes. */
export class StaticTokenProvider implements ShopifyTokenProvider {
  readonly authMode = "ACCESS_TOKEN" as const;
  constructor(private readonly token: string) {
    if (!token) throw new ShopifyError("AUTHENTICATION_ERROR", "Shopify access token is missing");
  }
  async getAccessToken(): Promise<string> {
    return this.token;
  }
  describe() {
    return { authMode: this.authMode, expiresAt: null, cached: true };
  }
}

export class ClientCredentialsTokenProvider implements ShopifyTokenProvider {
  readonly authMode = "CLIENT_CREDENTIALS" as const;
  private memo: ShopifyAccessToken | null = null;
  private inflight: Promise<ShopifyAccessToken> | null = null;
  private readonly now: () => Date;
  private readonly log: Logger;

  constructor(
    private readonly credentials: { shopDomain: string; clientId: string; clientSecret: string },
    private readonly opts: { cache?: ShopifyTokenCacheStore; fetchImpl?: typeof fetch; now?: () => Date; log?: Logger; refreshMarginMs?: number } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? logger.child({ connector: "shopify", shop: credentials.shopDomain });
  }

  private usable(t: { expiresAt: Date | null } | null): boolean {
    if (!t) return false;
    if (!t.expiresAt) return true;
    return t.expiresAt.getTime() - this.now().getTime() > (this.opts.refreshMarginMs ?? TOKEN_REFRESH_MARGIN_MS);
  }

  async getAccessToken(o: { forceRefresh?: boolean } = {}): Promise<string> {
    if (!o.forceRefresh) {
      if (this.usable(this.memo)) return this.memo!.accessToken;
      const cached = await this.opts.cache?.load();
      if (cached && this.usable(cached)) {
        this.memo = cached;
        return cached.accessToken;
      }
    }
    if (!this.inflight) {
      this.inflight = exchangeClientCredentials(this.credentials, { fetchImpl: this.opts.fetchImpl, now: this.now, log: this.log })
        .then(async (t) => {
          this.memo = t;
          await this.opts.cache?.save(t).catch((e) => this.log.warn("shopify.token_cache_save_failed", { error: String(e) }));
          return t;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return (await this.inflight).accessToken;
  }

  describe() {
    return { authMode: this.authMode, expiresAt: this.memo?.expiresAt ?? null, cached: !!this.memo };
  }
}

export function createTokenProvider(credentials: ShopifyCredentials, opts: { cache?: ShopifyTokenCacheStore; fetchImpl?: typeof fetch; now?: () => Date; log?: Logger } = {}): ShopifyTokenProvider {
  if (credentials.authMode === "ACCESS_TOKEN") return new StaticTokenProvider(credentials.accessToken);
  return new ClientCredentialsTokenProvider({ shopDomain: credentials.shopDomain, clientId: credentials.clientId, clientSecret: credentials.clientSecret }, opts);
}

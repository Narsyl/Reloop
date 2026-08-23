/**
 * Shopify Admin GraphQL client (revised Phase 4c) — READ-ONLY by construction.
 *
 *  - token from a `ShopifyTokenProvider` (client-credentials exchange + cache, or a static token)
 *  - API version pin, timeout, retries with jitter on 429 / 5xx / network, cost-based throttle waits
 *  - one automatic refresh-and-retry when Shopify answers 401 (expired/revoked token)
 *  - GraphQL `errors` → VALIDATION_ERROR / PERMISSION_ERROR / RATE_LIMITED; Zod-validated responses
 *  - **no mutations**: there is no `mutate()`; any document whose operation is a mutation is refused
 *    client-side with FORBIDDEN_OPERATION. The connector cannot write to Shopify even by mistake.
 *  - structured, redacted logging (tokens / secrets never logged)
 */
import type { z } from "zod";
import { ShopifyError, type ShopifyErrorKind } from "./errors";
import { normalizeShopDomain } from "./auth";
import type { ShopifyTokenProvider } from "./types";
import { logger, type Logger } from "@/lib/logging/logger";

export const SHOPIFY_API_VERSION = "2026-07";

export type ShopifyClientOptions = {
  shopDomain: string;
  tokenProvider: ShopifyTokenProvider;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  log?: Logger;
  correlationId?: string;
};

type GraphQLResponse = {
  data?: unknown;
  errors?: { message: string; extensions?: { code?: string; [k: string]: unknown }; path?: unknown }[];
  extensions?: { cost?: { requestedQueryCost?: number; actualQueryCost?: number; throttleStatus?: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number } } };
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** True when the document's top-level operation is anything but a query. */
export function isMutationDocument(document: string): boolean {
  const stripped = document.replace(/#[^\n]*/g, "").trim();
  return /^(mutation|subscription)\b/i.test(stripped);
}

export class ShopifyAdminClient {
  private readonly shopDomain: string;
  private readonly tokenProvider: ShopifyTokenProvider;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly log: Logger;
  readonly correlationId: string;
  private lastThrottle: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number } | null = null;

  constructor(opts: ShopifyClientOptions) {
    this.shopDomain = normalizeShopDomain(opts.shopDomain);
    this.tokenProvider = opts.tokenProvider;
    this.apiVersion = opts.apiVersion ?? SHOPIFY_API_VERSION;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.correlationId = opts.correlationId ?? `shp_${Math.random().toString(36).slice(2, 10)}`;
    this.log = opts.log ?? logger.child({ connector: "shopify", shop: this.shopDomain, correlationId: this.correlationId });
  }

  get endpoint(): string {
    return `https://${this.shopDomain}/admin/api/${this.apiVersion}/graphql.json`;
  }
  get shop(): string {
    return this.shopDomain;
  }
  get version(): string {
    return this.apiVersion;
  }
  get auth(): ShopifyTokenProvider {
    return this.tokenProvider;
  }

  /** Read-only GraphQL query. Mutation documents are refused before any network call. */
  async query<T>(operation: string, document: string, variables: Record<string, unknown> = {}, schema?: z.ZodType<T>): Promise<T> {
    if (isMutationDocument(document)) {
      throw new ShopifyError("FORBIDDEN_OPERATION", `Shopify operation "${operation}" is a mutation; this connector is read-only (catalogue reads for reward bindings only).`, { operation });
    }
    let attempt = 0;
    let refreshedOnce = false;
    for (;;) {
      await this.throttleIfNeeded();
      const startedAt = Date.now();
      const accessToken = await this.tokenProvider.getAccessToken();
      let response: Response;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", "X-Shopify-Access-Token": accessToken },
          body: JSON.stringify({ query: document, variables }),
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));
      } catch (e) {
        const err = new ShopifyError("NETWORK_ERROR", `Shopify request failed (${operation}): ${String((e as Error)?.message ?? e)}`, { operation, cause: e });
        if (attempt < this.maxRetries) {
          const delay = this.backoff(attempt);
          this.log.warn("shopify.retry", { operation, kind: err.kind, attempt: attempt + 1, delayMs: delay });
          attempt++;
          await sleep(delay);
          continue;
        }
        throw err;
      }
      const requestId = response.headers.get("x-request-id") ?? undefined;
      const durationMs = Date.now() - startedAt;

      if (response.status === 429 || response.status >= 500) {
        const retryAfterMs = Number(response.headers.get("retry-after") ?? "0") * 1000 || undefined;
        const kindFor: ShopifyErrorKind = response.status === 429 ? "RATE_LIMITED" : "REMOTE_SERVER_ERROR";
        if (attempt < this.maxRetries) {
          const delay = Math.max(retryAfterMs ?? 0, this.backoff(attempt));
          this.log.warn("shopify.retry", { operation, status: response.status, attempt: attempt + 1, delayMs: delay, requestId });
          attempt++;
          await sleep(delay);
          continue;
        }
        throw new ShopifyError(kindFor, `Shopify ${response.status} on ${operation}`, { status: response.status, requestId, operation, retryAfterMs });
      }
      if (response.status === 401) {
        // expired / revoked token: refresh once through the provider, then give up
        if (!refreshedOnce && this.tokenProvider.authMode === "CLIENT_CREDENTIALS") {
          refreshedOnce = true;
          this.log.warn("shopify.token_refresh", { operation, requestId });
          await this.tokenProvider.getAccessToken({ forceRefresh: true });
          continue;
        }
        throw new ShopifyError("AUTHENTICATION_ERROR", "Shopify rejected the access token (401). Check the app credentials and that the app is installed on this store.", { status: 401, requestId, operation });
      }
      if (response.status === 403) throw new ShopifyError("PERMISSION_ERROR", "Shopify refused the request (403) — the app lacks a required scope or the store blocks this API.", { status: 403, requestId, operation });
      if (response.status === 404) throw new ShopifyError("NOT_FOUND", `Shopify endpoint not found (404) — wrong shop domain or API version ${this.apiVersion}?`, { status: 404, requestId, operation });
      if (!response.ok) throw new ShopifyError("UNKNOWN", `Shopify ${response.status} on ${operation}`, { status: response.status, requestId, operation });

      let body: GraphQLResponse;
      try {
        body = (await response.json()) as GraphQLResponse;
      } catch (e) {
        throw new ShopifyError("SCHEMA_ERROR", `Shopify returned non-JSON for ${operation}`, { status: response.status, requestId, operation, cause: e });
      }
      const throttle = body.extensions?.cost?.throttleStatus;
      if (throttle) this.lastThrottle = throttle;
      this.log.debug("shopify.ok", { operation, status: response.status, durationMs, requestId, cost: body.extensions?.cost?.actualQueryCost, available: throttle?.currentlyAvailable });

      if (body.errors && body.errors.length > 0) {
        const codes = body.errors.map((e) => e.extensions?.code).filter(Boolean);
        const messages = body.errors.map((e) => e.message).join("; ");
        if (codes.includes("THROTTLED")) {
          if (attempt < this.maxRetries) {
            const delay = this.backoff(attempt) + 1000;
            this.log.warn("shopify.retry", { operation, kind: "THROTTLED", attempt: attempt + 1, delayMs: delay, requestId });
            attempt++;
            await sleep(delay);
            continue;
          }
          throw new ShopifyError("RATE_LIMITED", `Shopify throttled ${operation}`, { requestId, operation, details: body.errors });
        }
        if (codes.includes("ACCESS_DENIED") || /access denied|not approved|requires merchant approval/i.test(messages)) {
          throw new ShopifyError("PERMISSION_ERROR", `Shopify access denied on ${operation}: ${messages}`, { requestId, operation, details: body.errors });
        }
        throw new ShopifyError("VALIDATION_ERROR", `Shopify GraphQL error on ${operation}: ${messages}`, { requestId, operation, details: body.errors });
      }
      if (schema) {
        const parsed = schema.safeParse(body.data);
        if (!parsed.success) {
          const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`);
          this.log.warn("shopify.schema_mismatch", { operation, requestId, issues });
          throw new ShopifyError("SCHEMA_ERROR", `Shopify response for ${operation} did not match the expected shape: ${issues.join("; ")}`, { requestId, operation, details: { issues } });
        }
        return parsed.data;
      }
      return body.data as T;
    }
  }

  private async throttleIfNeeded() {
    const t = this.lastThrottle;
    if (!t) return;
    // keep a healthy margin: wait until at least 200 cost points (or 20% of the bucket) are available
    const floor = Math.min(200, Math.floor(t.maximumAvailable * 0.2));
    if (t.currentlyAvailable < floor) {
      const needed = floor - t.currentlyAvailable;
      const ms = Math.ceil((needed / Math.max(t.restoreRate, 1)) * 1000);
      this.log.debug("shopify.throttle_wait", { ms, available: t.currentlyAvailable });
      await sleep(Math.min(ms, 10_000));
      this.lastThrottle = { ...t, currentlyAvailable: floor };
    }
  }

  private backoff(attempt: number): number {
    const base = 500 * Math.pow(2, attempt);
    return base + Math.floor(Math.random() * 250);
  }
}

export function gidToId(gid: string): string {
  const m = /\/(\d+)(?:\?.*)?$/.exec(gid);
  if (!m) throw new ShopifyError("SCHEMA_ERROR", `Unexpected Shopify GID "${gid}"`);
  return m[1];
}
export function productGid(id: string): string {
  return id.startsWith("gid://") ? id : `gid://shopify/Product/${id}`;
}
export function variantGid(id: string): string {
  return id.startsWith("gid://") ? id : `gid://shopify/ProductVariant/${id}`;
}

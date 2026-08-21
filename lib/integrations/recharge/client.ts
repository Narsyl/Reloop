/**
 * The ONE place HTTP is spoken to Recharge.
 *
 *   - auth header + API version
 *   - per-request timeout
 *   - 429: honour Retry-After, retry with backoff
 *   - transient 5xx / network: retry with backoff + jitter
 *   - rate-limit header awareness (x-recharge-limit "used/limit") — backs off when near the cap
 *   - typed RechargeError taxonomy (errors.ts)
 *   - Zod validation of responses → SCHEMA_ERROR
 *   - structured, redacted logging with a correlation id
 *   - cursor pagination helper (Recharge 2021-11: first page carries filters, later
 *     pages carry ONLY `cursor` + `limit`)
 *
 * Credentials are passed in by the caller (decrypted per Integration). There is
 * deliberately no fallback to a global env token.
 */
import type { z } from "zod";
import { RechargeError, kindFromStatus } from "./errors";
import { logger, type Logger } from "@/lib/logging/logger";

export type RechargeCredentials = { apiToken: string; clientSecret?: string | null };

export type RechargeClientOptions = {
  credentials: RechargeCredentials;
  apiVersion?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Minimum spacing between requests (ms). Recharge allows ~2 req/s sustained. */
  minIntervalMs?: number;
  correlationId?: string;
  fetchImpl?: typeof fetch;
  log?: Logger;
  /** Test hook: replaces real sleeping. */
  sleep?: (ms: number) => Promise<void>;
};

export type RequestOptions<T> = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  schema?: z.ZodType<T>;
  /** Override per-request retries (e.g. 0 for capability probes). */
  maxRetries?: number;
};

const DEFAULT_BASE_URL = "https://api.rechargeapps.com";
const DEFAULT_VERSION = "2021-11";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MIN_INTERVAL_MS = 120;
const MAX_BACKOFF_MS = 8_000;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RechargeClient {
  private readonly credentials: RechargeCredentials;
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly minIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly correlationId: string;

  private lastRequestAt = 0;
  private requestCount = 0;
  /** Last seen "used/limit" from x-recharge-limit, for backoff + diagnostics. */
  rateLimit: { used: number; limit: number } | null = null;

  constructor(opts: RechargeClientOptions) {
    if (!opts.credentials?.apiToken) throw new RechargeError("AUTHENTICATION_ERROR", "Recharge API token is missing for this integration");
    this.credentials = opts.credentials;
    this.apiVersion = opts.apiVersion ?? process.env.RECHARGE_API_VERSION ?? DEFAULT_VERSION;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.correlationId = opts.correlationId ?? `rc_${Math.random().toString(36).slice(2, 10)}`;
    this.log = opts.log ?? logger.child({ connector: "recharge", correlationId: this.correlationId });
    this.sleep = opts.sleep ?? realSleep;
  }

  get clientSecret(): string | null {
    return this.credentials.clientSecret ?? null;
  }

  /** Number of HTTP requests issued by this client (diagnostics / tests). */
  get requestsMade(): number {
    return this.requestCount;
  }

  // ── public API ──────────────────────────────────────────────────────────

  async get<T = unknown>(path: string, opts: Omit<RequestOptions<T>, "method" | "body"> = {}): Promise<T> {
    return this.request<T>(path, { ...opts, method: "GET" });
  }

  /**
   * Generic request. Phase 2 callers only use GET; POST/PUT/DELETE exist for later
   * phases and are NOT used by sync or capability probing.
   */
  async request<T = unknown>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
    const method = opts.method ?? "GET";
    const url = this.buildUrl(path, opts.query);
    const maxRetries = opts.maxRetries ?? this.maxRetries;
    let attempt = 0;

    for (;;) {
      await this.throttle();
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await this.doFetch(url, method, opts.body);
      } catch (cause) {
        const isAbort = cause instanceof Error && cause.name === "AbortError";
        const err = new RechargeError("NETWORK_ERROR", isAbort ? `Recharge request timed out after ${this.timeoutMs}ms` : "Network error calling Recharge", {
          method,
          path,
          correlationId: this.correlationId,
          cause,
        });
        if (attempt < maxRetries) {
          const delay = this.backoff(attempt);
          this.log.warn("recharge.retry", { method, path, attempt: attempt + 1, kind: err.kind, delayMs: delay });
          await this.sleep(delay);
          attempt++;
          continue;
        }
        this.log.error("recharge.error", { method, path, attempt, kind: err.kind, message: err.message });
        throw err;
      }

      this.requestCount++;
      this.readRateLimit(response);
      const requestId = response.headers.get("x-request-id") ?? response.headers.get("x-recharge-request-id") ?? undefined;
      const durationMs = Date.now() - startedAt;

      if (response.ok) {
        const data = await this.parseBody(response);
        this.log.debug("recharge.ok", { method, path, status: response.status, durationMs, requestId, rateLimit: this.rateLimit });
        if (opts.schema) {
          const parsed = opts.schema.safeParse(data);
          if (!parsed.success) {
            const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`);
            throw new RechargeError("SCHEMA_ERROR", `Recharge response for ${method} ${path} did not match expected shape: ${issues.join("; ")}`, {
              status: response.status,
              method,
              path,
              requestId,
              correlationId: this.correlationId,
              details: { issues },
            });
          }
          return parsed.data;
        }
        return data as T;
      }

      // error path
      const body = await this.parseBody(response).catch(() => null);
      const kind = kindFromStatus(response.status);
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      const message = describeError(response.status, body);
      const err = new RechargeError(kind, message, {
        status: response.status,
        method,
        path,
        requestId,
        correlationId: this.correlationId,
        retryAfterMs,
        details: sanitizeBody(body),
      });

      if (err.retriable && attempt < maxRetries) {
        const delay = retryAfterMs ?? this.backoff(attempt);
        this.log.warn("recharge.retry", { method, path, status: response.status, attempt: attempt + 1, kind, delayMs: delay, requestId });
        await this.sleep(Math.min(delay, 30_000));
        attempt++;
        continue;
      }
      this.log[kind === "NOT_FOUND" ? "info" : "error"]("recharge.error", { method, path, status: response.status, kind, requestId, durationMs, message });
      throw err;
    }
  }

  /**
   * Iterate a cursor-paginated list endpoint. Yields arrays (pages).
   * `key` is the array property in the envelope (e.g. "subscriptions").
   */
  async *paginate<T>(
    path: string,
    opts: { key: string; query?: Record<string, string | number | boolean | undefined | null>; limit?: number; itemSchema?: z.ZodType<T>; startCursor?: string | null },
  ): AsyncGenerator<{ items: T[]; cursor: string | null; nextCursor: string | null; page: number }> {
    const limit = opts.limit ?? 250;
    let cursor: string | null = opts.startCursor ?? null;
    let page = 0;
    for (;;) {
      page++;
      // Recharge: when a cursor is supplied, no other filters may be sent (they are encoded in the cursor).
      const query = cursor ? { limit, cursor } : { limit, ...(opts.query ?? {}) };
      const envelope = await this.get<Record<string, unknown>>(path, { query });
      const raw = envelope?.[opts.key];
      if (!Array.isArray(raw)) {
        throw new RechargeError("SCHEMA_ERROR", `Recharge list response for ${path} has no array at "${opts.key}"`, { path, method: "GET", correlationId: this.correlationId });
      }
      let items: T[];
      if (opts.itemSchema) {
        items = [];
        for (const [i, item] of raw.entries()) {
          const parsed = opts.itemSchema.safeParse(item);
          if (!parsed.success) {
            const issues = parsed.error.issues.slice(0, 5).map((x) => `${x.path.join(".")}: ${x.message}`);
            throw new RechargeError("SCHEMA_ERROR", `Recharge ${opts.key}[${i}] did not match expected shape: ${issues.join("; ")}`, { path, method: "GET", correlationId: this.correlationId, details: { issues, index: i } });
          }
          items.push(parsed.data);
        }
      } else {
        items = raw as T[];
      }
      const nextCursor = typeof envelope?.next_cursor === "string" && envelope.next_cursor ? envelope.next_cursor : null;
      yield { items, cursor, nextCursor, page };
      if (!nextCursor || items.length === 0) return;
      cursor = nextCursor;
    }
  }

  // ── internals ───────────────────────────────────────────────────────────

  private buildUrl(path: string, query?: Record<string, string | number | boolean | undefined | null>): string {
    const url = new URL(path.startsWith("/") ? path : `/${path}`, this.baseUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === "") continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private async doFetch(url: string, method: string, body?: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method,
        headers: {
          "X-Recharge-Access-Token": this.credentials.apiToken,
          "X-Recharge-Version": this.apiVersion,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          "X-Correlation-Id": this.correlationId,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        cache: "no-store",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private readRateLimit(response: Response) {
    const header = response.headers.get("x-recharge-limit");
    if (!header) return;
    const m = /^(\d+)\s*\/\s*(\d+)/.exec(header);
    if (m) this.rateLimit = { used: Number(m[1]), limit: Number(m[2]) };
  }

  /** Minimum spacing + back off when the provider reports we are near the limit. */
  private async throttle() {
    const now = Date.now();
    let wait = Math.max(0, this.lastRequestAt + this.minIntervalMs - now);
    if (this.rateLimit && this.rateLimit.limit > 0 && this.rateLimit.used >= this.rateLimit.limit - 2) {
      wait = Math.max(wait, 1_000);
    }
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = Date.now();
  }

  private backoff(attempt: number): number {
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
    return Math.round(base / 2 + Math.random() * (base / 2));
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function describeError(status: number, body: unknown): string {
  const detail = extractMessage(body);
  const base =
    status === 401
      ? "Recharge rejected the API token"
      : status === 403
        ? "Recharge token lacks permission for this resource (or the resource is not on the store's plan)"
        : status === 404
          ? "Recharge resource not found"
          : status === 429
            ? "Recharge rate limit reached"
            : status === 400 || status === 422
              ? "Recharge rejected the request as invalid"
              : status >= 500
                ? "Recharge server error"
                : `Recharge returned HTTP ${status}`;
  return detail ? `${base}: ${detail}` : `${base} (HTTP ${status})`;
}

function extractMessage(body: unknown): string | null {
  if (!body) return null;
  if (typeof body === "string") return body.slice(0, 200);
  if (typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.error === "string") return b.error;
    if (b.errors && typeof b.errors === "object") {
      try {
        return JSON.stringify(b.errors).slice(0, 300);
      } catch {
        return null;
      }
    }
    if (typeof b.message === "string") return b.message;
  }
  return null;
}

function sanitizeBody(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const { error, errors, message } = body as Record<string, unknown>;
  return { error, errors, message };
}

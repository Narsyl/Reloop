/**
 * Shopify connector error taxonomy (Phase 4c). Every failure leaving the Shopify client is one of
 * these kinds so callers decide retry-vs-exception without string matching.
 */
export type ShopifyErrorKind =
  | "AUTHENTICATION_ERROR" // 401 — token invalid/revoked
  | "PERMISSION_ERROR" // 403 / ACCESS_DENIED — token lacks a scope
  | "RATE_LIMITED" // 429 / THROTTLED
  | "NOT_FOUND" // resource null where one was expected
  | "USER_ERROR" // mutation userErrors (validation by Shopify)
  | "VALIDATION_ERROR" // GraphQL errors (bad query / variables)
  | "REMOTE_SERVER_ERROR" // 5xx
  | "NETWORK_ERROR" // DNS / connect / timeout / aborted
  | "SCHEMA_ERROR" // response did not match the Zod schema we rely on
  | "FORBIDDEN_OPERATION" // a mutation outside the connector's allowlist was attempted (defence in depth)
  | "UNKNOWN";

const RETRIABLE: ReadonlySet<ShopifyErrorKind> = new Set(["RATE_LIMITED", "REMOTE_SERVER_ERROR", "NETWORK_ERROR"]);

export class ShopifyError extends Error {
  readonly kind: ShopifyErrorKind;
  readonly status?: number;
  readonly retriable: boolean;
  readonly requestId?: string;
  readonly operation?: string;
  readonly retryAfterMs?: number;
  readonly details?: unknown;

  constructor(kind: ShopifyErrorKind, message: string, opts: { status?: number; requestId?: string; operation?: string; retryAfterMs?: number; details?: unknown; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ShopifyError";
    this.kind = kind;
    this.status = opts.status;
    this.retriable = RETRIABLE.has(kind);
    this.requestId = opts.requestId;
    this.operation = opts.operation;
    this.retryAfterMs = opts.retryAfterMs;
    this.details = opts.details;
  }

  toJSON() {
    return { name: this.name, kind: this.kind, message: this.message, status: this.status, retriable: this.retriable, requestId: this.requestId, operation: this.operation, details: this.details };
  }
}

export function isShopifyError(e: unknown): e is ShopifyError {
  return e instanceof ShopifyError;
}

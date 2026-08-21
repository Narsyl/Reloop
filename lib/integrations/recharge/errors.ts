/**
 * Connector error taxonomy. Every failure that leaves the Recharge client is one
 * of these kinds, so callers can decide retry-vs-exception without string matching.
 */
export type RechargeErrorKind =
  | "AUTHENTICATION_ERROR" // 401 — token invalid/revoked
  | "PERMISSION_ERROR" // 403 — token lacks scope, or resource not on plan
  | "RATE_LIMITED" // 429
  | "NOT_FOUND" // 404
  | "VALIDATION_ERROR" // 400 / 422
  | "REMOTE_SERVER_ERROR" // 5xx
  | "NETWORK_ERROR" // DNS / connect / timeout / aborted
  | "SCHEMA_ERROR" // response did not match the Zod schema we rely on
  | "UNKNOWN";

const RETRIABLE: ReadonlySet<RechargeErrorKind> = new Set(["RATE_LIMITED", "REMOTE_SERVER_ERROR", "NETWORK_ERROR"]);

export class RechargeError extends Error {
  readonly kind: RechargeErrorKind;
  readonly status?: number;
  readonly retriable: boolean;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly path?: string;
  readonly method?: string;
  readonly retryAfterMs?: number;
  /** Parsed error body if Recharge returned one (never includes credentials). */
  readonly details?: unknown;

  constructor(
    kind: RechargeErrorKind,
    message: string,
    opts: {
      status?: number;
      requestId?: string;
      correlationId?: string;
      path?: string;
      method?: string;
      retryAfterMs?: number;
      details?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "RechargeError";
    this.kind = kind;
    this.status = opts.status;
    this.retriable = RETRIABLE.has(kind);
    this.requestId = opts.requestId;
    this.correlationId = opts.correlationId;
    this.path = opts.path;
    this.method = opts.method;
    this.retryAfterMs = opts.retryAfterMs;
    this.details = opts.details;
  }

  /** Safe, log-friendly summary. */
  toJSON() {
    return {
      name: this.name,
      kind: this.kind,
      status: this.status,
      retriable: this.retriable,
      message: this.message,
      method: this.method,
      path: this.path,
      requestId: this.requestId,
      correlationId: this.correlationId,
    };
  }
}

export function kindFromStatus(status: number): RechargeErrorKind {
  if (status === 401) return "AUTHENTICATION_ERROR";
  if (status === 403) return "PERMISSION_ERROR";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status === 400 || status === 422) return "VALIDATION_ERROR";
  if (status >= 500) return "REMOTE_SERVER_ERROR";
  return "UNKNOWN";
}

export function isRechargeError(e: unknown): e is RechargeError {
  return e instanceof RechargeError;
}

/** True when the error means "this request will not succeed if repeated as-is". */
export function isTerminal(e: unknown): boolean {
  return isRechargeError(e) ? !e.retriable : true;
}

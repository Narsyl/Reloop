/**
 * External (commerce-platform) ID normalisation — the ONE place that knows the
 * shapes Recharge uses for Shopify ids.
 *
 * Recharge 2021-11 exposes external ids inconsistently by resource:
 *   - plain string        "123456"
 *   - plain number        123456
 *   - object              { ecommerce: "123456" } | { ecommerce: 123456 }
 *
 * Everything downstream receives canonical strings ("123456") or null.
 *
 * Rules:
 *   - absent (undefined / null / { ecommerce: null }) → null
 *   - present but malformed (empty string, "null", "undefined", non-integer,
 *     boolean, object without a usable `ecommerce`, …) → ExternalIdError
 *   - required fields that are absent → ExternalIdError
 * Never "", "undefined", "null" or "NaN".
 */
import { z } from "zod";
import { RechargeError } from "./errors";

export type ExternalIdContext = {
  /** Recharge resource, e.g. "subscription", "order.line_item", "product.variant" */
  resource: string;
  /** field name on that resource, e.g. "external_product_id" */
  field: string;
  /** the Recharge object's own id, when known — makes the error actionable */
  recordId?: string | number | null;
};

export class ExternalIdError extends RechargeError {
  readonly resource: string;
  readonly field: string;
  readonly recordId: string | null;
  readonly received: string;

  constructor(ctx: ExternalIdContext, received: unknown, reason: "missing" | "malformed") {
    const recordPart = ctx.recordId !== undefined && ctx.recordId !== null ? ` (${ctx.resource} ${ctx.recordId})` : ` (${ctx.resource})`;
    const receivedDesc = describe(received);
    super(
      "SCHEMA_ERROR",
      reason === "missing"
        ? `Recharge ${ctx.resource}.${ctx.field} is required but missing${recordPart}`
        : `Recharge ${ctx.resource}.${ctx.field} has an unrecognised id shape${recordPart}: ${receivedDesc}`,
      { details: { resource: ctx.resource, field: ctx.field, recordId: ctx.recordId ?? null, received: receivedDesc, reason } },
    );
    this.name = "ExternalIdError";
    this.resource = ctx.resource;
    this.field = ctx.field;
    this.recordId = ctx.recordId === undefined || ctx.recordId === null ? null : String(ctx.recordId);
    this.received = receivedDesc;
  }
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return `"${v.slice(0, 40)}"`;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === "object") {
    const keys = Object.keys(v as object).slice(0, 5);
    return `object{${keys.join(",")}}`;
  }
  return typeof v;
}

const BAD_STRINGS = new Set(["", "null", "undefined", "nan", "none", "[object object]"]);

type ParseResult = { ok: true; id: string | null } | { ok: false };

/** Parse any supported representation. `ok:false` = present but malformed. */
export function parseExternalId(value: unknown): ParseResult {
  if (value === null || value === undefined) return { ok: true, id: null };
  if (typeof value === "string") {
    const s = value.trim();
    if (BAD_STRINGS.has(s.toLowerCase())) return s === "" ? { ok: true, id: null } : { ok: false };
    return { ok: true, id: s };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return { ok: false };
    // avoid scientific notation / precision loss on very large ids
    return { ok: true, id: Number.isSafeInteger(value) ? String(value) : BigInt(value).toString() };
  }
  if (typeof value === "bigint") return value >= BigInt(0) ? { ok: true, id: value.toString() } : { ok: false };
  if (typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (!("ecommerce" in obj)) return { ok: false };
    const inner = obj.ecommerce;
    if (inner !== null && typeof inner === "object") return { ok: false }; // no nesting
    return parseExternalId(inner);
  }
  return { ok: false };
}

/** Canonical string id, or null when absent. Throws on malformed input. */
export function optionalExternalId(value: unknown, ctx: ExternalIdContext): string | null {
  const r = parseExternalId(value);
  if (!r.ok) throw new ExternalIdError(ctx, value, "malformed");
  return r.id;
}

/** Canonical string id. Throws on absent or malformed input. */
export function requiredExternalId(value: unknown, ctx: ExternalIdContext): string {
  const r = parseExternalId(value);
  if (!r.ok) throw new ExternalIdError(ctx, value, "malformed");
  if (r.id === null) throw new ExternalIdError(ctx, value, "missing");
  return r.id;
}

/**
 * Zod schema for an optional external id field: accepts every supported shape,
 * yields string | null, and reports malformed input as a schema issue (so the
 * client surfaces it as a SCHEMA_ERROR naming the path).
 */
export const externalIdSchema = z.unknown().transform((value, ctx): string | null => {
  const r = parseExternalId(value);
  if (!r.ok) {
    ctx.addIssue({ code: "custom", message: `unrecognised external id shape: ${describe(value)}` });
    return z.NEVER;
  }
  return r.id;
});

/** Zod schema for a Recharge-native id (subscription id, customer id, …): always required. */
export const rechargeIdSchema = z.unknown().transform((value, ctx): string => {
  const r = parseExternalId(value);
  if (!r.ok || r.id === null) {
    ctx.addIssue({ code: "custom", message: `invalid or missing id: ${describe(value)}` });
    return z.NEVER;
  }
  return r.id;
});

/** Optional Recharge-native id (e.g. charge_id may be absent). */
export const rechargeIdOptionalSchema = externalIdSchema;

/**
 * One-times.
 *
 * Reads (Phase 2): discovery of pre-existing one-times + duplicate reconciliation.
 * Phase 6 adds the platform's ONLY business-data write — createOnetime (POST /onetimes, no blind
 * retry) — plus getOnetime (read-back verification) and deleteOnetime (explicit controlled-test
 * rollback only). Nothing else on Recharge is writable.
 */
import { z } from "zod";
import type { RechargeClient } from "./client";
import { rcOnetimeEnvelopeSchema, rcOnetimeSchema } from "./schemas";
import { mapOnetime } from "./mapper";
import { RechargeError } from "./errors";
import type { ConnectorOnetime, ListOptions } from "@/lib/integrations/types";

/** Exact POST /onetimes body — built by the domain payload builder (identical to the dry-run preview). */
export type RechargeOnetimeCreateBody = {
  address_id: number | string;
  next_charge_scheduled_at: string;
  external_variant_id: { ecommerce: string };
  external_product_id?: { ecommerce: string };
  product_title: string;
  quantity: number;
  price: string;
  properties: { name: string; value: string }[];
};

export async function getOnetime(client: RechargeClient, externalOnetimeId: string): Promise<ConnectorOnetime | null> {
  if (!/^\d+$/.test(externalOnetimeId)) throw new RechargeError("VALIDATION_ERROR", `getOnetime requires a numeric id (got "${externalOnetimeId}")`, {});
  try {
    const data = await client.get(`/onetimes/${externalOnetimeId}`, { schema: rcOnetimeEnvelopeSchema });
    return mapOnetime(data.onetime);
  } catch (e) {
    if (e instanceof RechargeError && e.kind === "NOT_FOUND") return null;
    throw e;
  }
}

/**
 * The ONE write: create a one-time. The response body is Zod-validated; a 2xx whose body does not
 * contain a well-formed one-time throws SCHEMA_ERROR — callers must treat that as an UNCERTAIN
 * outcome (the write may exist) and reconcile by reading, never mark success on a bare 2xx.
 */
export async function createOnetime(client: RechargeClient, body: RechargeOnetimeCreateBody): Promise<ConnectorOnetime> {
  const data = await client.createOnetime(body as unknown as Record<string, unknown>, { schema: rcOnetimeEnvelopeSchema as z.ZodType<{ onetime: z.infer<typeof rcOnetimeSchema> }> });
  return mapOnetime(data.onetime);
}

export async function* listOnetimes(
  client: RechargeClient,
  opts: ListOptions & { externalAddressId?: string; externalCustomerId?: string; startCursor?: string | null } = {},
): AsyncGenerator<{ items: ConnectorOnetime[]; nextCursor: string | null; page: number }> {
  for await (const page of client.paginate("/onetimes", {
    key: "onetimes",
    itemSchema: rcOnetimeSchema,
    limit: opts.limit ?? 250,
    startCursor: opts.startCursor,
    query: { address_id: opts.externalAddressId, customer_id: opts.externalCustomerId, updated_at_min: opts.updatedSince?.toISOString() },
  })) {
    yield { items: page.items.map(mapOnetime), nextCursor: page.nextCursor, page: page.page };
  }
}

/**
 * One-times — READ ONLY in Phase 2.
 *
 * Reading existing one-times lets us discover pre-existing manual fulfilment
 * markers and, later, reconcile duplicates. Create/update/delete are added with
 * the action executor in Phase 5 and are intentionally absent here so nothing in
 * the sync pipeline can mutate Recharge.
 */
import type { RechargeClient } from "./client";
import { rcOnetimeSchema } from "./schemas";
import { mapOnetime } from "./mapper";
import type { ConnectorOnetime, ListOptions } from "@/lib/integrations/types";

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

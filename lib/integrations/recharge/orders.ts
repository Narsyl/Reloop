import type { RechargeClient } from "./client";
import { orderEnvelope, rcOrderSchema } from "./schemas";
import { mapOrder } from "./mapper";
import type { ConnectorOrder, ListOptions } from "@/lib/integrations/types";

export type OrderStatusFilter = "success" | "error" | "queued" | "cancelled";

/**
 * Lists orders. For historical cycle calculation we walk ALL successful orders
 * once (status=success, oldest first) and attribute line items to subscriptions
 * by purchase_item_id — one pass instead of one call per subscription.
 */
export async function* listOrders(
  client: RechargeClient,
  opts: ListOptions & { status?: OrderStatusFilter; purchaseItemId?: string; customerId?: string; startCursor?: string | null } = {},
): AsyncGenerator<{ items: ConnectorOrder[]; nextCursor: string | null; page: number }> {
  for await (const page of client.paginate("/orders", {
    key: "orders",
    itemSchema: rcOrderSchema,
    limit: opts.limit ?? 250,
    startCursor: opts.startCursor,
    query: {
      status: opts.status,
      purchase_item_id: opts.purchaseItemId,
      customer_id: opts.customerId,
      updated_at_min: opts.updatedSince?.toISOString(),
      sort_by: "id-asc",
    },
  })) {
    yield { items: page.items.map(mapOrder), nextCursor: page.nextCursor, page: page.page };
  }
}

export async function getOrder(client: RechargeClient, externalOrderId: string): Promise<ConnectorOrder> {
  const data = await client.get(`/orders/${encodeURIComponent(externalOrderId)}`, { schema: orderEnvelope });
  return mapOrder(data.order);
}

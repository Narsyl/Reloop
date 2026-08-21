import type { RechargeClient } from "./client";
import { rcSubscriptionSchema, subscriptionEnvelope } from "./schemas";
import { mapSubscription } from "./mapper";
import type { ConnectorSubscription, ListOptions } from "@/lib/integrations/types";

export type SubscriptionStatusFilter = "active" | "cancelled" | "expired";
export const SUBSCRIPTION_STATUSES: SubscriptionStatusFilter[] = ["active", "cancelled", "expired"];

/**
 * Lists subscriptions for ONE status (Recharge filters by status; iterate all
 * three for a full import). `startCursor` resumes a partially completed page walk.
 */
export async function* listSubscriptions(
  client: RechargeClient,
  opts: ListOptions & { status: SubscriptionStatusFilter; startCursor?: string | null },
): AsyncGenerator<{ items: ConnectorSubscription[]; nextCursor: string | null; page: number }> {
  for await (const page of client.paginate("/subscriptions", {
    key: "subscriptions",
    itemSchema: rcSubscriptionSchema,
    limit: opts.limit ?? 250,
    startCursor: opts.startCursor,
    query: { status: opts.status, updated_at_min: opts.updatedSince?.toISOString() },
  })) {
    yield { items: page.items.map(mapSubscription), nextCursor: page.nextCursor, page: page.page };
  }
}

export async function getSubscription(client: RechargeClient, externalSubscriptionId: string): Promise<ConnectorSubscription> {
  const data = await client.get(`/subscriptions/${encodeURIComponent(externalSubscriptionId)}`, { schema: subscriptionEnvelope });
  return mapSubscription(data.subscription);
}

/**
 * Recharge connector — the object the rest of the app talks to.
 * Built from a RechargeClient that already carries this integration's credentials.
 */
import { RechargeClient, type RechargeClientOptions, type RechargeCredentials } from "./client";
import { getStore } from "./store";
import { probeCapabilities } from "./capabilities";
import { listCustomers } from "./customers";
import { listProducts } from "./products";
import { getSubscription, listSubscriptions, SUBSCRIPTION_STATUSES, type SubscriptionStatusFilter } from "./subscriptions";
import { getOrder, listOrders, type OrderStatusFilter } from "./orders";
import { createOnetime, getOnetime, listOnetimes, type RechargeOnetimeCreateBody } from "./onetimes";
import { createWebhookSubscription, deleteWebhookSubscription, listRegisteredWebhooks } from "./webhooks";
import type { ListOptions } from "@/lib/integrations/types";

export type RechargeConnector = ReturnType<typeof createRechargeConnector>;

export function createRechargeConnector(client: RechargeClient) {
  return {
    provider: "RECHARGE" as const,
    client,
    getStore: () => getStore(client),
    probeCapabilities: () => probeCapabilities(client),
    listCustomers: (opts?: ListOptions & { startCursor?: string | null }) => listCustomers(client, opts),
    listProducts: (opts?: ListOptions & { startCursor?: string | null }) => listProducts(client, opts),
    listSubscriptions: (opts: ListOptions & { status: SubscriptionStatusFilter; startCursor?: string | null }) => listSubscriptions(client, opts),
    getSubscription: (id: string) => getSubscription(client, id),
    listOrders: (opts?: ListOptions & { status?: OrderStatusFilter; purchaseItemId?: string; customerId?: string; startCursor?: string | null }) => listOrders(client, opts),
    getOrder: (id: string) => getOrder(client, id),
    listOnetimes: (opts?: ListOptions & { externalAddressId?: string; externalCustomerId?: string; startCursor?: string | null }) => listOnetimes(client, opts),
    getOnetime: (id: string) => getOnetime(client, id),
    // Phase 6: the platform's ONLY business-data write (+ explicit controlled-test rollback delete)
    createOnetime: (body: RechargeOnetimeCreateBody) => createOnetime(client, body),
    deleteOnetime: (id: string) => client.deleteOnetime(id),
    // Phase 5: webhook SUBSCRIPTION management (POST/DELETE strictly on /webhooks paths)
    listWebhooks: () => listRegisteredWebhooks(client),
    createWebhook: (input: { address: string; topic: string }) => createWebhookSubscription(client, input),
    deleteWebhook: (id: string) => deleteWebhookSubscription(client, id),
    subscriptionStatuses: SUBSCRIPTION_STATUSES,
  };
}

/** Build a connector from raw credentials (used by "Test connection" before anything is saved). */
export function createRechargeConnectorFromCredentials(credentials: RechargeCredentials, opts: Omit<RechargeClientOptions, "credentials"> = {}) {
  return createRechargeConnector(new RechargeClient({ credentials, ...opts }));
}

export { RechargeClient };
export type { RechargeCredentials };

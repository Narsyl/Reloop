/**
 * Provider-agnostic connector contract and the normalised DTOs the rest of the
 * application consumes. Provider peculiarities (field names, id shapes, date
 * formats) stop at the connector boundary — see lib/integrations/recharge/mapper.ts.
 *
 * All ids are strings. "external" ids refer to the commerce platform's ids
 * (Shopify product/variant ids as exposed by the subscription provider) so that
 * products, subscriptions and order lines all join on the same identity.
 */

export type ConnectorStore = {
  externalStoreId: string;
  name: string;
  domain: string | null;
  email: string | null;
  currency: string | null;
  timezone: string | null;
};

export type ConnectorCustomer = {
  externalCustomerId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  externalCreatedAt: Date | null;
  externalUpdatedAt: Date | null;
};

export type ConnectorVariant = {
  externalVariantId: string;
  title: string;
  sku: string | null;
  price: string | null; // decimal as string
};

export type ConnectorProduct = {
  externalProductId: string;
  providerProductId: string | null; // the subscription provider's own id, for debugging
  title: string;
  active: boolean;
  variants: ConnectorVariant[];
  /** variants the provider returned without a commerce id (skipped, counted) */
  skippedVariants: number;
  providerData: Record<string, unknown> | null;
};

export type ConnectorSubscriptionStatus = "active" | "cancelled" | "expired" | "unknown";

export type ConnectorSubscription = {
  externalSubscriptionId: string;
  externalCustomerId: string;
  externalAddressId: string;
  status: ConnectorSubscriptionStatus;
  providerStatus: string; // raw status string from the provider
  externalProductId: string;
  externalVariantId: string;
  productTitle: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  price: string | null;
  intervalUnit: string | null;
  intervalFrequency: number | null;
  nextChargeDate: string | null; // YYYY-MM-DD exactly as the provider gives it
  externalCreatedAt: Date | null;
  externalUpdatedAt: Date | null;
  cancelledAt: Date | null;
  providerData: Record<string, unknown> | null;
};

export type ConnectorOrderKind = "CHECKOUT" | "RECURRING";

export type ConnectorOrderLine = {
  purchaseItemId: string | null; // the provider subscription/one-time id this line belongs to
  purchaseItemType: "subscription" | "onetime" | "unknown";
  externalProductId: string | null;
  externalVariantId: string | null;
  quantity: number;
  title: string | null;
  sku: string | null;
};

export type ConnectorOrder = {
  externalOrderId: string;
  externalCustomerId: string | null;
  externalAddressId: string | null;
  externalChargeId: string | null;
  platformOrderId: string | null; // e.g. Shopify order id
  status: string; // provider status ("success", "error", "queued", "cancelled")
  kind: ConnectorOrderKind;
  processedAt: Date | null;
  scheduledAt: string | null;
  lineItems: ConnectorOrderLine[];
};

export type ConnectorOnetime = {
  externalOnetimeId: string;
  externalAddressId: string;
  externalCustomerId: string | null;
  externalProductId: string | null;
  externalVariantId: string | null;
  nextChargeDate: string | null;
  productTitle: string | null;
  sku: string | null;
  quantity: number;
  price: string | null;
  externalCreatedAt: Date | null;
};

export type CapabilityState = "available" | "read" | "read_write" | "unavailable" | "unknown";

export type CapabilityMap = {
  store: CapabilityState;
  customers: CapabilityState;
  products: CapabilityState;
  orders: CapabilityState;
  subscriptions: CapabilityState; // read / read_write
  onetimes: CapabilityState; // read / read_write
  webhooks: CapabilityState;
  // optional / premium — reported, never required, never probed by calling premium endpoints
  charges: CapabilityState;
  events: CapabilityState;
  credits: CapabilityState;
  customer_sessions: CapabilityState;
};

export const REQUIRED_CAPABILITIES: (keyof CapabilityMap)[] = ["store", "customers", "products", "orders", "subscriptions", "onetimes", "webhooks"];

export function requiredCapabilitiesAvailable(caps: CapabilityMap): boolean {
  return REQUIRED_CAPABILITIES.every((k) => caps[k] !== "unavailable" && caps[k] !== "unknown");
}

export type CapabilityReport = {
  capabilities: CapabilityMap;
  scopes: string[] | null; // token scopes if the provider exposes them
  notes: string[]; // human-readable findings ("Events API not on plan", ...)
  checkedAt: Date;
};

export type ListPage<T> = { items: T[]; nextCursor: string | null };

export type ListOptions = { updatedSince?: Date; limit?: number };

/** What the rest of the app is allowed to ask a subscription platform for (Phase 2: read-only). */
export interface SubscriptionConnector {
  readonly provider: "RECHARGE";
  getStore(): Promise<ConnectorStore>;
  probeCapabilities(): Promise<CapabilityReport>;
  listCustomers(opts?: ListOptions): AsyncIterable<ConnectorCustomer[]>;
  listProducts(opts?: ListOptions): AsyncIterable<ConnectorProduct[]>;
  listSubscriptions(opts?: ListOptions & { status?: "active" | "cancelled" | "expired" }): AsyncIterable<ConnectorSubscription[]>;
  getSubscription(externalSubscriptionId: string): Promise<ConnectorSubscription>;
  listOrders(opts?: ListOptions & { status?: "success" | "error" | "queued" | "cancelled"; purchaseItemId?: string }): AsyncIterable<ConnectorOrder[]>;
  getOrder(externalOrderId: string): Promise<ConnectorOrder>;
  listOnetimes(opts?: ListOptions & { externalAddressId?: string }): AsyncIterable<ConnectorOnetime[]>;
}

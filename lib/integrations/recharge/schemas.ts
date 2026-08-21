/**
 * Zod schemas for the Recharge 2021-11 responses we rely on.
 *
 * Deliberately LOOSE: we validate the fields our behaviour depends on and pass
 * everything else through, so a new optional field from Recharge never breaks
 * an import. Ids are normalised to strings (Recharge sends numbers).
 */
import { z } from "zod";

export const idSchema = z.union([z.number(), z.string()]).transform((v) => String(v));
export const nullableId = idSchema.nullable().optional();

/** `{ ecommerce: "123" }` shape Recharge uses for Shopify ids. */
export const ecommerceIdSchema = z
  .union([z.looseObject({ ecommerce: z.union([z.number(), z.string()]).nullable().optional() }), z.number(), z.string()])
  .nullable()
  .optional()
  .transform((v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === "number" || typeof v === "string") return String(v);
    return v.ecommerce === null || v.ecommerce === undefined ? null : String(v.ecommerce);
  });

export const dateString = z.string().nullable().optional();
const numberish = z.union([z.number(), z.string()]).nullable().optional();

// ── store / token ──────────────────────────────────────────────────────────
export const rcStoreSchema = z.looseObject({
  id: nullableId,
  name: z.string().nullable().optional(),
  domain: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  iana_timezone: z.string().nullable().optional(),
  shop_email: z.string().nullable().optional(),
  external_platform: z.string().nullable().optional(),
});
export const storeEnvelope = z.looseObject({ store: rcStoreSchema });
export type RcStore = z.infer<typeof rcStoreSchema>;

export const tokenInformationEnvelope = z.looseObject({
  token_information: z.looseObject({
    name: z.string().nullable().optional(),
    contact_email: z.string().nullable().optional(),
    scopes: z.array(z.string()).nullable().optional(),
  }),
});

// ── customers ──────────────────────────────────────────────────────────────
export const rcCustomerSchema = z.looseObject({
  id: idSchema,
  email: z.string().nullable().optional(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  created_at: dateString,
  updated_at: dateString,
  external_customer_id: ecommerceIdSchema,
});
export type RcCustomer = z.infer<typeof rcCustomerSchema>;

// ── products ───────────────────────────────────────────────────────────────
export const rcVariantSchema = z.looseObject({
  external_variant_id: ecommerceIdSchema,
  title: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
  prices: z.looseObject({ unit_price: numberish, discounted_price: numberish }).nullable().optional(),
  price: numberish,
});
export const rcProductSchema = z.looseObject({
  id: nullableId,
  external_product_id: ecommerceIdSchema,
  title: z.string().nullable().optional(),
  handle: z.string().nullable().optional(),
  published_at: dateString,
  deleted_at: dateString,
  variants: z.array(rcVariantSchema).nullable().optional(),
  images: z.unknown().optional(),
});
export type RcProduct = z.infer<typeof rcProductSchema>;

// ── subscriptions ──────────────────────────────────────────────────────────
export const rcSubscriptionSchema = z.looseObject({
  id: idSchema,
  customer_id: idSchema,
  address_id: idSchema,
  status: z.string(),
  created_at: dateString,
  updated_at: dateString,
  cancelled_at: dateString,
  cancellation_reason: z.string().nullable().optional(),
  next_charge_scheduled_at: dateString,
  product_title: z.string().nullable().optional(),
  variant_title: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
  price: numberish,
  quantity: numberish,
  order_interval_unit: z.string().nullable().optional(),
  order_interval_frequency: numberish,
  charge_interval_frequency: numberish,
  external_product_id: ecommerceIdSchema,
  external_variant_id: ecommerceIdSchema,
  has_queued_charge: z.union([z.boolean(), z.number(), z.string()]).nullable().optional(),
  is_skippable: z.boolean().nullable().optional(),
  is_swappable: z.boolean().nullable().optional(),
});
export const subscriptionEnvelope = z.looseObject({ subscription: rcSubscriptionSchema });
export type RcSubscription = z.infer<typeof rcSubscriptionSchema>;

// ── orders ─────────────────────────────────────────────────────────────────
export const rcOrderLineSchema = z.looseObject({
  purchase_item_id: nullableId,
  purchase_item_type: z.string().nullable().optional(),
  subscription_id: nullableId, // older payload shape
  external_product_id: ecommerceIdSchema,
  external_variant_id: ecommerceIdSchema,
  quantity: numberish,
  title: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
});
export const rcOrderSchema = z.looseObject({
  id: idSchema,
  customer_id: nullableId,
  customer: z.looseObject({ id: nullableId }).nullable().optional(),
  address_id: nullableId,
  charge_id: nullableId,
  charge: z.looseObject({ id: nullableId }).nullable().optional(),
  status: z.string(),
  type: z.string().nullable().optional(),
  processed_at: dateString,
  scheduled_at: dateString,
  created_at: dateString,
  updated_at: dateString,
  external_order_id: ecommerceIdSchema,
  line_items: z.array(rcOrderLineSchema).nullable().optional(),
});
export const orderEnvelope = z.looseObject({ order: rcOrderSchema });
export type RcOrder = z.infer<typeof rcOrderSchema>;

// ── one-times ──────────────────────────────────────────────────────────────
export const rcOnetimeSchema = z.looseObject({
  id: idSchema,
  address_id: idSchema,
  customer_id: nullableId,
  next_charge_scheduled_at: dateString,
  product_title: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
  quantity: numberish,
  price: numberish,
  created_at: dateString,
  external_product_id: ecommerceIdSchema,
  external_variant_id: ecommerceIdSchema,
});
export type RcOnetime = z.infer<typeof rcOnetimeSchema>;

// ── webhooks ───────────────────────────────────────────────────────────────
export const rcWebhookSchema = z.looseObject({
  id: idSchema,
  address: z.string(),
  topic: z.string(),
});

/**
 * Zod schemas for the Recharge 2021-11 responses we rely on.
 *
 * Deliberately LOOSE: we validate the fields our behaviour depends on and pass
 * everything else through, so a new optional field from Recharge never breaks
 * an import.
 *
 * IDs: Recharge-native ids (id, customer_id, address_id, purchase_item_id …) and
 * external commerce ids (external_product_id, external_variant_id …) are both
 * normalised to canonical strings by lib/integrations/recharge/ids.ts, whatever
 * shape Recharge used ("123", 123, { ecommerce: "123" }, { ecommerce: 123 }).
 * Malformed shapes fail validation (→ SCHEMA_ERROR). Required-ness of external
 * ids is enforced in the mapper, where the owning record id is known.
 */
import { z } from "zod";
import { externalIdSchema, rechargeIdOptionalSchema, rechargeIdSchema } from "./ids";

export const dateString = z.string().nullable().optional();
const numberish = z.union([z.number(), z.string()]).nullable().optional();

// ── store / token ──────────────────────────────────────────────────────────
/** 2021-11 returns timezone as an object ({ iana_name, name }); older/other shapes return a string. */
const storeTimezone = z
  .union([z.string(), z.looseObject({ iana_name: z.string().nullable().optional(), name: z.string().nullable().optional() })])
  .nullable()
  .optional()
  .transform((v) => (v === null || v === undefined ? null : typeof v === "string" ? v : (v.iana_name ?? v.name ?? null)));

export const rcStoreSchema = z.looseObject({
  id: rechargeIdOptionalSchema.optional(),
  name: z.string().nullable().optional(),
  domain: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  timezone: storeTimezone,
  iana_timezone: z.string().nullable().optional(),
  shop_email: z.string().nullable().optional(),
  external_platform: z.string().nullable().optional(),
});
export const storeEnvelope = z.looseObject({ store: rcStoreSchema });
export type RcStore = z.infer<typeof rcStoreSchema>;

/** Observed live: fields are top-level ({ scopes, name, contact_email, client }); docs show a `token_information` wrapper. Accept both. */
const tokenInfoFields = {
  name: z.string().nullable().optional(),
  contact_email: z.string().nullable().optional(),
  scopes: z.array(z.string()).nullable().optional(),
};
export const tokenInformationEnvelope = z
  .looseObject({ token_information: z.looseObject(tokenInfoFields).nullable().optional(), ...tokenInfoFields })
  .transform((v) => ({ token_information: { name: v.token_information?.name ?? v.name ?? null, contact_email: v.token_information?.contact_email ?? v.contact_email ?? null, scopes: v.token_information?.scopes ?? v.scopes ?? null } }));

// ── customers ──────────────────────────────────────────────────────────────
export const rcCustomerSchema = z.looseObject({
  id: rechargeIdSchema,
  email: z.string().nullable().optional(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  created_at: dateString,
  updated_at: dateString,
  external_customer_id: externalIdSchema.optional(),
});
export type RcCustomer = z.infer<typeof rcCustomerSchema>;

// ── products ───────────────────────────────────────────────────────────────
export const rcVariantSchema = z.looseObject({
  external_variant_id: externalIdSchema.optional(),
  title: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
  prices: z.looseObject({ unit_price: numberish, discounted_price: numberish }).nullable().optional(),
  price: numberish,
});
export const rcProductSchema = z.looseObject({
  id: rechargeIdOptionalSchema.optional(),
  external_product_id: externalIdSchema.optional(),
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
  id: rechargeIdSchema,
  customer_id: rechargeIdSchema,
  address_id: rechargeIdSchema,
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
  external_product_id: externalIdSchema.optional(),
  external_variant_id: externalIdSchema.optional(),
  has_queued_charge: z.union([z.boolean(), z.number(), z.string()]).nullable().optional(),
  is_skippable: z.boolean().nullable().optional(),
  is_swappable: z.boolean().nullable().optional(),
});
export const subscriptionEnvelope = z.looseObject({ subscription: rcSubscriptionSchema });
export type RcSubscription = z.infer<typeof rcSubscriptionSchema>;

// ── orders ─────────────────────────────────────────────────────────────────
export const rcOrderLineSchema = z.looseObject({
  purchase_item_id: rechargeIdOptionalSchema.optional(),
  purchase_item_type: z.string().nullable().optional(),
  subscription_id: rechargeIdOptionalSchema.optional(), // older payload shape
  external_product_id: externalIdSchema.optional(),
  external_variant_id: externalIdSchema.optional(),
  quantity: numberish,
  title: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
});
export const rcOrderSchema = z.looseObject({
  id: rechargeIdSchema,
  customer_id: rechargeIdOptionalSchema.optional(),
  customer: z.looseObject({ id: rechargeIdOptionalSchema.optional() }).nullable().optional(),
  address_id: rechargeIdOptionalSchema.optional(),
  charge_id: rechargeIdOptionalSchema.optional(),
  charge: z.looseObject({ id: rechargeIdOptionalSchema.optional() }).nullable().optional(),
  status: z.string(),
  type: z.string().nullable().optional(),
  processed_at: dateString,
  scheduled_at: dateString,
  created_at: dateString,
  updated_at: dateString,
  external_order_id: externalIdSchema.optional(),
  line_items: z.array(rcOrderLineSchema).nullable().optional(),
});
export const orderEnvelope = z.looseObject({ order: rcOrderSchema });
export type RcOrder = z.infer<typeof rcOrderSchema>;

// ── one-times ──────────────────────────────────────────────────────────────
export const rcOnetimeSchema = z.looseObject({
  id: rechargeIdSchema,
  address_id: rechargeIdSchema,
  customer_id: rechargeIdOptionalSchema.optional(),
  next_charge_scheduled_at: dateString,
  product_title: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
  quantity: numberish,
  price: numberish,
  created_at: dateString,
  external_product_id: externalIdSchema.optional(),
  external_variant_id: externalIdSchema.optional(),
});
export type RcOnetime = z.infer<typeof rcOnetimeSchema>;

// ── webhooks ───────────────────────────────────────────────────────────────
export const rcWebhookSchema = z.looseObject({
  id: rechargeIdSchema,
  address: z.string(),
  topic: z.string(),
});

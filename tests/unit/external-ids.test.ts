/**
 * External-ID normalisation: every Recharge id shape → canonical string; required
 * ids that are missing/malformed → typed ExternalIdError (SCHEMA_ERROR). Nothing
 * ever becomes "", "null" or "undefined".
 */
import { describe, expect, it } from "vitest";
import { ExternalIdError, externalIdSchema, optionalExternalId, parseExternalId, rechargeIdSchema, requiredExternalId } from "@/lib/integrations/recharge/ids";
import { rcOnetimeSchema, rcOrderSchema, rcProductSchema, rcSubscriptionSchema } from "@/lib/integrations/recharge/schemas";
import { mapOnetime, mapOrder, mapProduct, mapSubscription } from "@/lib/integrations/recharge/mapper";
import { RechargeError } from "@/lib/integrations/recharge/errors";

const ctx = { resource: "test", field: "external_product_id", recordId: 42 };

describe("parseExternalId / helpers", () => {
  it.each([
    ["123456", "123456"],
    [" 123456 ", "123456"],
    [123456, "123456"],
    [{ ecommerce: "123456" }, "123456"],
    [{ ecommerce: 123456 }, "123456"],
    [{ ecommerce: " 77 " }, "77"],
    ["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/1"], // passed through as-is; Recharge sends numerics
  ])("normalises %j → %s", (input, expected) => {
    expect(requiredExternalId(input, ctx)).toBe(expected);
    expect(optionalExternalId(input, ctx)).toBe(expected);
    expect(externalIdSchema.parse(input)).toBe(expected);
  });

  it("normalises bigint and very large numeric ids without precision loss or scientific notation", () => {
    expect(requiredExternalId(BigInt("9007199254740993"), ctx)).toBe("9007199254740993");
    expect(requiredExternalId(1e21, ctx)).toBe("1000000000000000000000");
    expect(externalIdSchema.parse(BigInt("12"))).toBe("12");
  });

  it.each([[null], [undefined], [""], ["   "], [{ ecommerce: null }], [{ ecommerce: undefined }], [{ ecommerce: "" }]])("treats %j as absent (null) for optional fields", (input) => {
    expect(parseExternalId(input)).toEqual({ ok: true, id: null });
    expect(optionalExternalId(input, ctx)).toBeNull();
    expect(externalIdSchema.parse(input)).toBeNull();
  });

  it("throws a typed error when a REQUIRED id is absent", () => {
    for (const input of [null, undefined, "", { ecommerce: null }]) {
      const err = (() => {
        try {
          requiredExternalId(input, ctx);
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(ExternalIdError);
      expect(err).toBeInstanceOf(RechargeError);
      expect((err as ExternalIdError).kind).toBe("SCHEMA_ERROR");
      expect((err as ExternalIdError).retriable).toBe(false);
      expect((err as ExternalIdError).message).toMatch(/test\.external_product_id is required but missing \(test 42\)/);
    }
  });

  it.each([["null"], ["undefined"], ["NaN"], [true], [1.5], [-3], [Number.NaN], [Number.POSITIVE_INFINITY], [{ foo: 1 }], [{ ecommerce: { nested: 1 } }], [[123]], [() => 1]])(
    "rejects malformed %j for both optional and required fields",
    (input) => {
      expect(parseExternalId(input)).toEqual({ ok: false });
      expect(() => optionalExternalId(input, ctx)).toThrow(ExternalIdError);
      expect(() => requiredExternalId(input, ctx)).toThrow(/unrecognised id shape/);
      expect(externalIdSchema.safeParse(input).success).toBe(false);
    },
  );

  it("never yields the strings 'undefined', 'null' or ''", () => {
    for (const input of [undefined, null, "", "undefined", "null", { ecommerce: "undefined" }]) {
      const r = parseExternalId(input);
      if (r.ok && r.id !== null) expect(r.id).not.toMatch(/^(undefined|null|)$/);
    }
  });

  it("rechargeIdSchema requires a value", () => {
    expect(rechargeIdSchema.parse(55)).toBe("55");
    expect(rechargeIdSchema.parse("55")).toBe("55");
    expect(rechargeIdSchema.safeParse(null).success).toBe(false);
    expect(rechargeIdSchema.safeParse("").success).toBe(false);
    expect(rechargeIdSchema.safeParse(undefined).success).toBe(false);
  });
});

describe("mapper-level required/optional handling by resource", () => {
  it("product: external_product_id as plain string and numeric; variant ids plain string", () => {
    const asString = mapProduct(rcProductSchema.parse({ id: 1, external_product_id: "8001", title: "MM", variants: [{ external_variant_id: "9001", title: "30" }] }));
    expect(asString?.externalProductId).toBe("8001");
    expect(asString?.variants[0].externalVariantId).toBe("9001");
    const asNumber = mapProduct(rcProductSchema.parse({ id: 1, external_product_id: 8001, variants: [{ external_variant_id: 9001 }] }));
    expect(asNumber?.externalProductId).toBe("8001");
    expect(asNumber?.variants[0].externalVariantId).toBe("9001");
    const asObject = mapProduct(rcProductSchema.parse({ id: 1, external_product_id: { ecommerce: 8001 }, variants: [{ external_variant_id: { ecommerce: "9001" } }] }));
    expect(asObject?.externalProductId).toBe("8001");
    expect(asObject?.variants[0].externalVariantId).toBe("9001");
  });

  it("product: missing product id → skipped (null); missing variant id → skipped and counted", () => {
    expect(mapProduct(rcProductSchema.parse({ id: 2, title: "no id" }))).toBeNull();
    const p = mapProduct(rcProductSchema.parse({ id: 3, external_product_id: "1", variants: [{ external_variant_id: "2" }, { title: "orphan" }, { external_variant_id: null }] }));
    expect(p?.variants).toHaveLength(1);
    expect(p?.skippedVariants).toBe(2);
  });

  it("product: malformed ids fail schema validation", () => {
    expect(rcProductSchema.safeParse({ id: 1, external_product_id: { foo: "bar" } }).success).toBe(false);
    expect(rcProductSchema.safeParse({ id: 1, external_product_id: "8001", variants: [{ external_variant_id: true }] }).success).toBe(false);
  });

  it("subscription: { ecommerce: string } and { ecommerce: number } and plain string/number", () => {
    const base = { id: 123, customer_id: 55, address_id: 77, status: "active" };
    for (const [p, v] of [
      [{ ecommerce: "8001" }, { ecommerce: "9001" }],
      [{ ecommerce: 8001 }, { ecommerce: 9001 }],
      ["8001", "9001"],
      [8001, 9001],
    ] as const) {
      const s = mapSubscription(rcSubscriptionSchema.parse({ ...base, external_product_id: p, external_variant_id: v }));
      expect(s.externalProductId).toBe("8001");
      expect(s.externalVariantId).toBe("9001");
      expect(s.externalSubscriptionId).toBe("123");
    }
  });

  it("subscription: missing product or variant id throws ExternalIdError naming the subscription", () => {
    const base = { id: 123, customer_id: 55, address_id: 77, status: "active" };
    expect(() => mapSubscription(rcSubscriptionSchema.parse({ ...base, external_variant_id: "9001" }))).toThrow(/subscription\.external_product_id is required but missing \(subscription 123\)/);
    expect(() => mapSubscription(rcSubscriptionSchema.parse({ ...base, external_product_id: "8001", external_variant_id: { ecommerce: null } }))).toThrow(ExternalIdError);
    expect(rcSubscriptionSchema.safeParse({ ...base, external_product_id: { nope: 1 } }).success).toBe(false);
  });

  it("order line: subscription lines require product/variant ids; one-time lines do not; missing optional ids → null", () => {
    const order = { id: 5001, status: "success", type: "recurring", processed_at: "2026-03-01T06:00:00" };
    const ok = mapOrder(
      rcOrderSchema.parse({
        ...order,
        line_items: [
          { purchase_item_id: 123, purchase_item_type: "subscription", external_product_id: { ecommerce: 8001 }, external_variant_id: "9001" },
          { purchase_item_id: 999, purchase_item_type: "onetime", external_product_id: null, external_variant_id: undefined },
        ],
      }),
    );
    expect(ok.lineItems[0]).toMatchObject({ purchaseItemId: "123", externalProductId: "8001", externalVariantId: "9001" });
    expect(ok.lineItems[1]).toMatchObject({ purchaseItemId: "999", externalProductId: null, externalVariantId: null });
    expect(() => mapOrder(rcOrderSchema.parse({ ...order, line_items: [{ purchase_item_id: 123, purchase_item_type: "subscription", external_product_id: "8001" }] }))).toThrow(
      /order\.line_item\.external_variant_id is required but missing \(order\.line_item 5001#0 \(purchase_item 123\)\)/,
    );
    expect(rcOrderSchema.safeParse({ ...order, line_items: [{ purchase_item_id: 1, purchase_item_type: "subscription", external_product_id: [1] }] }).success).toBe(false);
  });

  it("onetime: ids normalised when present, null when absent", () => {
    const t = mapOnetime(rcOnetimeSchema.parse({ id: 77, address_id: 1, external_product_id: { ecommerce: 7777 }, external_variant_id: "8888", price: "0" }));
    expect(t).toMatchObject({ externalOnetimeId: "77", externalAddressId: "1", externalProductId: "7777", externalVariantId: "8888", price: "0.00" });
    const bare = mapOnetime(rcOnetimeSchema.parse({ id: 78, address_id: 1 }));
    expect(bare.externalProductId).toBeNull();
    expect(bare.externalVariantId).toBeNull();
    expect(rcOnetimeSchema.safeParse({ id: 78, address_id: 1, external_variant_id: { ecommerce: { deep: 1 } } }).success).toBe(false);
  });

  it("recharge-native ids must be present (subscription without id fails validation)", () => {
    expect(rcSubscriptionSchema.safeParse({ customer_id: 1, address_id: 1, status: "active" }).success).toBe(false);
    expect(rcSubscriptionSchema.safeParse({ id: "", customer_id: 1, address_id: 1, status: "active" }).success).toBe(false);
  });
});

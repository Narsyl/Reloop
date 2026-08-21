import { describe, expect, it } from "vitest";
import { rcOrderSchema, rcProductSchema, rcSubscriptionSchema, storeEnvelope } from "@/lib/integrations/recharge/schemas";
import { mapOrder, mapProduct, mapStore, mapSubscription } from "@/lib/integrations/recharge/mapper";
import { collectSubscriptionLines } from "@/lib/domain/sync/stages";

describe("Recharge mapper", () => {
  it("maps a store", () => {
    const parsed = storeEnvelope.parse({ store: { id: 1, name: "Ancient Extracts", domain: "ae.myshopify.com", email: "a@b.c", currency: "GBP", iana_timezone: "Europe/London", extra: 1 } });
    expect(mapStore(parsed.store)).toEqual({ externalStoreId: "ae.myshopify.com", name: "Ancient Extracts", domain: "ae.myshopify.com", email: "a@b.c", currency: "GBP", timezone: "Europe/London" });
  });

  it("accepts the 2021-11 store timezone object shape and string shape", () => {
    const obj = storeEnvelope.parse({ store: { id: 1, name: "S", domain: "s.myshopify.com", timezone: { iana_name: "Europe/London", name: "(GMT+00:00) London" } } });
    expect(mapStore(obj.store).timezone).toBe("Europe/London");
    const str = storeEnvelope.parse({ store: { id: 1, name: "S", domain: "s.myshopify.com", timezone: "Europe/Dublin" } });
    expect(mapStore(str.store).timezone).toBe("Europe/Dublin");
    const none = storeEnvelope.parse({ store: { id: 1, name: "S", timezone: null } });
    expect(mapStore(none.store).timezone).toBeNull();
  });

  it("maps a subscription using commerce (Shopify) product/variant ids and date-only next charge", () => {
    const raw = rcSubscriptionSchema.parse({
      id: 123,
      customer_id: 55,
      address_id: 77,
      status: "active",
      product_title: "Morning Magic",
      variant_title: "30 servings",
      sku: "MM-30",
      price: "34.00",
      quantity: "1",
      order_interval_unit: "day",
      order_interval_frequency: "30",
      next_charge_scheduled_at: "2026-09-21T00:00:00",
      external_product_id: { ecommerce: "8001" },
      external_variant_id: { ecommerce: 9001 },
      created_at: "2026-01-05T10:00:00",
      has_queued_charge: 1,
    });
    const s = mapSubscription(raw);
    expect(s.externalSubscriptionId).toBe("123");
    expect(s.externalCustomerId).toBe("55");
    expect(s.externalProductId).toBe("8001");
    expect(s.externalVariantId).toBe("9001");
    expect(s.nextChargeDate).toBe("2026-09-21");
    expect(s.intervalFrequency).toBe(30);
    expect(s.status).toBe("active");
    expect(s.price).toBe("34.00");
    expect(s.externalCreatedAt?.toISOString().startsWith("2026-01-05")).toBe(true);
  });

  it("maps a product with variants; products without a commerce id are skipped", () => {
    const p = mapProduct(rcProductSchema.parse({ id: 1, external_product_id: { ecommerce: "8001" }, title: "Morning Magic", variants: [{ external_variant_id: { ecommerce: "9001" }, title: "30", sku: "MM-30", prices: { unit_price: "34" } }, { title: "no id" }] }));
    expect(p?.variants).toHaveLength(1);
    expect(p?.variants[0]).toEqual({ externalVariantId: "9001", title: "30", sku: "MM-30", price: "34.00" });
    expect(mapProduct(rcProductSchema.parse({ id: 2, title: "orphan" }))).toBeNull();
  });

  it("maps an order and collects only successful subscription lines (one per subscription)", () => {
    const o = mapOrder(
      rcOrderSchema.parse({
        id: 5001,
        customer: { id: 55 },
        address_id: 77,
        charge: { id: 9,  },
        status: "SUCCESS",
        type: "recurring",
        processed_at: "2026-03-01T06:00:00",
        external_order_id: { ecommerce: "S-1" },
        line_items: [
          { purchase_item_id: 123, purchase_item_type: "subscription", external_product_id: { ecommerce: "8001" }, external_variant_id: { ecommerce: "9001" }, quantity: 1, title: "Morning Magic" },
          { purchase_item_id: 123, purchase_item_type: "subscription", external_product_id: { ecommerce: "8001" }, external_variant_id: { ecommerce: "9001" }, quantity: 1, title: "dup line" },
          { purchase_item_id: 999, purchase_item_type: "onetime", external_product_id: { ecommerce: "7777" }, title: "Morning Magic 2" },
        ],
      }),
    );
    expect(o.kind).toBe("RECURRING");
    expect(o.status).toBe("success");
    expect(o.externalCustomerId).toBe("55");
    expect(o.externalChargeId).toBe("9");
    const lines = collectSubscriptionLines([o]);
    expect(lines).toHaveLength(1);
    expect(lines[0].externalSubscriptionId).toBe("123");
    expect(lines[0].data.orderKind).toBe("RECURRING");
    // non-success orders contribute nothing
    expect(collectSubscriptionLines([{ ...o, status: "error" }])).toHaveLength(0);
  });

  it("treats legacy subscription_id line items as subscription lines", () => {
    const o = mapOrder(rcOrderSchema.parse({ id: 1, status: "success", type: "checkout", processed_at: "2026-01-01T00:00:00", line_items: [{ subscription_id: 42, external_product_id: { ecommerce: "1" }, external_variant_id: { ecommerce: "2" } }] }));
    expect(o.kind).toBe("CHECKOUT");
    expect(o.lineItems[0].purchaseItemType).toBe("subscription");
    expect(o.lineItems[0].purchaseItemId).toBe("42");
  });
});

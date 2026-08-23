import { describe, expect, it, vi } from "vitest";
import { RechargeClient } from "@/lib/integrations/recharge/client";
import { webhookDedupeKey, extractWebhookResource, PHASE5_WEBHOOK_TOPICS } from "@/lib/integrations/recharge/webhooks";

function client() {
  const calls: { url: string; method: string }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    return new Response(JSON.stringify({ webhook: { id: 1, address: "https://x", topic: "order/created" }, webhooks: [] }), { status: 200 });
  });
  return { c: new RechargeClient({ credentials: { apiToken: "tok_1234567890123456789012" }, fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMs: 0 }), calls };
}

describe("RechargeClient.webhookAdmin — the only non-GET surface, allowlisted to /webhooks", () => {
  it("allows POST /webhooks and DELETE /webhooks/{id}", async () => {
    const { c, calls } = client();
    await c.webhookAdmin("POST", "/webhooks", { body: { address: "https://x", topic: "order/created" } });
    await c.webhookAdmin("DELETE", "/webhooks/123");
    expect(calls.map((x) => x.method)).toEqual(["POST", "DELETE"]);
  });
  it("refuses every other path before any HTTP — /onetimes stays impossible", async () => {
    const { c, calls } = client();
    for (const path of ["/onetimes", "/subscriptions/1", "/orders/1", "/webhooks/1/extra", "/webhooksx", "/onetimes?x=/webhooks", "/customers"]) {
      await expect(c.webhookAdmin("POST", path)).rejects.toThrow(/Refused/);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("webhook dedupe + resource extraction", () => {
  it("dedupe key is deterministic per (topic, raw body) and distinguishes topics and bodies", () => {
    const body = '{"order":{"id":1}}';
    expect(webhookDedupeKey("order/created", body)).toBe(webhookDedupeKey("order/created", body));
    expect(webhookDedupeKey("order/created", body)).not.toBe(webhookDedupeKey("order/processed", body));
    expect(webhookDedupeKey("order/created", body)).not.toBe(webhookDedupeKey("order/created", '{"order":{"id":2}}'));
  });
  it("extracts the resource identity for display only", () => {
    expect(extractWebhookResource("order/created", { order: { id: 42 } })).toEqual({ kind: "order", externalId: "42" });
    expect(extractWebhookResource("subscription/cancelled", { subscription: { id: "7" } })).toEqual({ kind: "subscription", externalId: "7" });
    expect(extractWebhookResource("charge/created", { charge: { id: 1 } })).toEqual({ kind: "unknown", externalId: null });
    expect(extractWebhookResource("order/created", null)).toEqual({ kind: "order", externalId: null });
  });
  it("Phase 5 subscribes to exactly the six approved topics", () => {
    expect([...PHASE5_WEBHOOK_TOPICS]).toEqual(["order/created", "order/processed", "subscription/created", "subscription/updated", "subscription/activated", "subscription/cancelled"]);
  });
});

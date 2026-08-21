import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RechargeClient } from "@/lib/integrations/recharge/client";
import { RechargeError } from "@/lib/integrations/recharge/errors";

type Call = { url: string; init: RequestInit };

function mockFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> } | Error>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const noSleep = async () => {};
const creds = { credentials: { apiToken: "tok_test_abcdefghijklmnopqrstuvwxyz" }, sleep: noSleep, minIntervalMs: 0 };

describe("RechargeClient", () => {
  it("sends auth + version headers and never a global env token", async () => {
    process.env.RECHARGE_API_TOKEN = "SHOULD_NOT_BE_USED";
    const { fetchImpl, calls } = mockFetch([{ status: 200, body: { store: { name: "S" } } }]);
    const client = new RechargeClient({ ...creds, fetchImpl });
    await client.get("/store");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["X-Recharge-Access-Token"]).toBe("tok_test_abcdefghijklmnopqrstuvwxyz");
    expect(headers["X-Recharge-Version"]).toBe("2021-11");
    expect(headers["X-Correlation-Id"]).toBe(client.correlationId);
    delete process.env.RECHARGE_API_TOKEN;
  });

  it("refuses to construct without a token", () => {
    expect(() => new RechargeClient({ credentials: { apiToken: "" } })).toThrow(RechargeError);
  });

  it.each([
    [401, "AUTHENTICATION_ERROR", false],
    [403, "PERMISSION_ERROR", false],
    [404, "NOT_FOUND", false],
    [422, "VALIDATION_ERROR", false],
    [400, "VALIDATION_ERROR", false],
  ])("maps HTTP %i to %s (retriable=%s) without retrying", async (status, kind, retriable) => {
    const { fetchImpl, calls } = mockFetch([{ status, body: { error: "nope" } }]);
    const client = new RechargeClient({ ...creds, fetchImpl });
    const err = await client.get("/subscriptions").then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e as RechargeError,
    );
    expect(err).toBeInstanceOf(RechargeError);
    expect(err.kind).toBe(kind);
    expect(err.retriable).toBe(retriable);
    expect(err.status).toBe(status);
    expect(calls).toHaveLength(1);
  });

  it("retries 429 honouring Retry-After, then succeeds", async () => {
    const { fetchImpl, calls } = mockFetch([
      { status: 429, body: { error: "slow down" }, headers: { "retry-after": "1" } },
      { status: 200, body: { ok: true } },
    ]);
    const slept: number[] = [];
    const client = new RechargeClient({ ...creds, fetchImpl, sleep: async (ms) => void slept.push(ms) });
    const res = await client.get<{ ok: boolean }>("/customers");
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(slept).toContain(1000);
  });

  it("retries 5xx up to maxRetries then throws REMOTE_SERVER_ERROR (retriable)", async () => {
    const { fetchImpl, calls } = mockFetch([{ status: 503, body: "unavailable" }]);
    const client = new RechargeClient({ ...creds, fetchImpl, maxRetries: 2 });
    const err = await client.get("/orders").then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e as RechargeError,
    );
    expect(err.kind).toBe("REMOTE_SERVER_ERROR");
    expect(err.retriable).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("classifies network failures and timeouts as NETWORK_ERROR and retries", async () => {
    const { fetchImpl, calls } = mockFetch([new TypeError("fetch failed"), { status: 200, body: { store: {} } }]);
    const client = new RechargeClient({ ...creds, fetchImpl });
    await client.get("/store");
    expect(calls).toHaveLength(2);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const m2 = mockFetch([abort]);
    const c2 = new RechargeClient({ ...creds, fetchImpl: m2.fetchImpl, maxRetries: 0 });
    const err = await c2.get("/store").then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e as RechargeError,
    );
    expect(err.kind).toBe("NETWORK_ERROR");
    expect(err.message).toMatch(/timed out/);
  });

  it("validates responses with the given schema → SCHEMA_ERROR on mismatch", async () => {
    const { fetchImpl } = mockFetch([{ status: 200, body: { store: { name: 123 } } }]);
    const client = new RechargeClient({ ...creds, fetchImpl });
    const err = await client.get("/store", { schema: z.object({ store: z.object({ name: z.string() }) }) }).then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e as RechargeError,
    );
    expect(err.kind).toBe("SCHEMA_ERROR");
    expect(err.retriable).toBe(false);
  });

  it("paginates with cursor semantics: filters only on the first request, cursor+limit afterwards", async () => {
    const { fetchImpl, calls } = mockFetch([
      { status: 200, body: { subscriptions: [{ id: 1 }, { id: 2 }], next_cursor: "c2" } },
      { status: 200, body: { subscriptions: [{ id: 3 }], next_cursor: null } },
    ]);
    const client = new RechargeClient({ ...creds, fetchImpl });
    const pages: number[][] = [];
    for await (const p of client.paginate<{ id: number }>("/subscriptions", { key: "subscriptions", query: { status: "active" }, limit: 2 })) {
      pages.push(p.items.map((i) => i.id));
    }
    expect(pages).toEqual([[1, 2], [3]]);
    const u1 = new URL(calls[0].url);
    const u2 = new URL(calls[1].url);
    expect(u1.searchParams.get("status")).toBe("active");
    expect(u1.searchParams.get("limit")).toBe("2");
    expect(u2.searchParams.get("cursor")).toBe("c2");
    expect(u2.searchParams.get("status")).toBeNull();
  });

  it("records rate-limit headers", async () => {
    const { fetchImpl } = mockFetch([{ status: 200, body: {}, headers: { "x-recharge-limit": "39/40" } }]);
    const client = new RechargeClient({ ...creds, fetchImpl });
    await client.get("/store");
    expect(client.rateLimit).toEqual({ used: 39, limit: 40 });
  });

  it("error toJSON never includes the token", async () => {
    const { fetchImpl } = mockFetch([{ status: 401, body: { error: "bad" } }]);
    const client = new RechargeClient({ ...creds, fetchImpl });
    const err = await client.get("/store").then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e as RechargeError,
    );
    expect(JSON.stringify(err.toJSON())).not.toContain("tok_test");
  });
});

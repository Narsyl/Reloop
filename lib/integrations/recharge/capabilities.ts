/**
 * Empirical capability detection.
 *
 * Rules (Phase 2 constraint 4):
 *  - We never trust the token-permission UI; we probe the endpoints we rely on.
 *  - Core connection health depends ONLY on the required set (store, customers,
 *    products, orders, subscriptions, one-times, webhooks).
 *  - Premium resources (events, credits, customer sessions) are reported from the
 *    token's declared scopes when available and are NEVER called.
 *  - Probes are GET ?limit=1 with no retries; a 403/404 marks the resource
 *    unavailable (missing scope or not on plan), a 401 aborts everything.
 */
import type { RechargeClient } from "./client";
import { RechargeError, isRechargeError } from "./errors";
import { tokenInformationEnvelope } from "./schemas";
import type { CapabilityMap, CapabilityReport, CapabilityState } from "@/lib/integrations/types";

type Probe = { key: keyof CapabilityMap; path: string; query?: Record<string, string | number> };

const REQUIRED_PROBES: Probe[] = [
  { key: "store", path: "/store" },
  { key: "customers", path: "/customers", query: { limit: 1 } },
  { key: "products", path: "/products", query: { limit: 1 } },
  { key: "orders", path: "/orders", query: { limit: 1 } },
  { key: "subscriptions", path: "/subscriptions", query: { limit: 1 } },
  { key: "onetimes", path: "/onetimes", query: { limit: 1 } },
  { key: "webhooks", path: "/webhooks", query: { limit: 1 } },
];

/** Optional, non-premium resources we may use later for verification; probed cheaply. */
const OPTIONAL_PROBES: Probe[] = [{ key: "charges", path: "/charges", query: { limit: 1 } }];

/** Premium resources: reported from scopes only. Never requested. */
const PREMIUM_BY_SCOPE: { key: keyof CapabilityMap; scopes: string[]; label: string }[] = [
  { key: "events", scopes: ["read_events"], label: "Events API" },
  { key: "credits", scopes: ["read_credits", "write_credits", "read_accounts", "write_accounts", "read_credit", "write_credit"], label: "Credits" },
  { key: "customer_sessions", scopes: ["write_customer_sessions", "read_customer_sessions", "customer_sessions"], label: "Storefront customer sessions" },
];

async function getScopes(client: RechargeClient, notes: string[]): Promise<string[] | null> {
  try {
    const data = await client.get("/token_information", { schema: tokenInformationEnvelope, maxRetries: 1 });
    const scopes = data.token_information.scopes ?? null;
    if (!scopes) notes.push("Token information did not include scopes; write permissions could not be verified.");
    return scopes;
  } catch (e) {
    if (isRechargeError(e) && e.kind === "AUTHENTICATION_ERROR") throw e;
    notes.push("Token information endpoint unavailable; write permissions could not be verified.");
    return null;
  }
}

async function probe(client: RechargeClient, p: Probe, notes: string[]): Promise<CapabilityState> {
  try {
    await client.get(p.path, { query: p.query, maxRetries: 1 });
    return "available";
  } catch (e) {
    if (!isRechargeError(e)) {
      notes.push(`${p.key}: unexpected error while probing.`);
      return "unknown";
    }
    if (e.kind === "AUTHENTICATION_ERROR") throw e;
    if (e.kind === "PERMISSION_ERROR") {
      notes.push(`${p.key}: token lacks permission (HTTP 403).`);
      return "unavailable";
    }
    if (e.kind === "NOT_FOUND") {
      notes.push(`${p.key}: endpoint not available for this store/plan (HTTP 404).`);
      return "unavailable";
    }
    notes.push(`${p.key}: could not be verified (${e.kind}).`);
    return "unknown";
  }
}

function hasScope(scopes: string[] | null, wanted: string[]): boolean | null {
  if (!scopes) return null;
  const set = new Set(scopes.map((s) => s.toLowerCase()));
  return wanted.some((w) => set.has(w));
}

export async function probeCapabilities(client: RechargeClient): Promise<CapabilityReport> {
  const notes: string[] = [];
  const scopes = await getScopes(client, notes);

  const caps: CapabilityMap = {
    store: "unknown",
    customers: "unknown",
    products: "unknown",
    orders: "unknown",
    subscriptions: "unknown",
    onetimes: "unknown",
    webhooks: "unknown",
    charges: "unknown",
    events: "unknown",
    credits: "unknown",
    customer_sessions: "unknown",
  };

  for (const p of REQUIRED_PROBES) caps[p.key] = await probe(client, p, notes);
  for (const p of OPTIONAL_PROBES) caps[p.key] = await probe(client, p, notes);

  // Refine read vs read/write for subscriptions & one-times from declared scopes.
  const canWriteSubs = hasScope(scopes, ["write_subscriptions"]);
  for (const key of ["subscriptions", "onetimes"] as const) {
    if (caps[key] === "available") {
      caps[key] = canWriteSubs === true ? "read_write" : "read";
      if (canWriteSubs === false) notes.push(`${key}: token is read-only (write_subscriptions scope missing) — automation will need it before going live.`);
    }
  }

  for (const prem of PREMIUM_BY_SCOPE) {
    const has = hasScope(scopes, prem.scopes);
    caps[prem.key] = has === null ? "unknown" : has ? "available" : "unavailable";
    if (has === false) notes.push(`${prem.label}: not granted/available on the current Recharge plan — not required.`);
  }

  if (caps.store === "unavailable") {
    throw new RechargeError("PERMISSION_ERROR", "Token cannot read store information; this permission is required to connect.");
  }

  return { capabilities: caps, scopes, notes, checkedAt: new Date() };
}

/**
 * Publications — READ-ONLY: list the sales channels and find "Online Store" so bindings can show whether
 * the bound product is published there. Optional (needs read_publications); nothing depends on it.
 */
import type { ShopifyAdminClient } from "./client";
import { publicationsSchema } from "./schemas";
import type { ShopifyPublication } from "./types";

const PUBLICATIONS_QUERY = `query SubscriptionOpsPublications { publications(first: 25) { nodes { id name catalog { title } } } }`;

export async function listPublications(client: ShopifyAdminClient): Promise<ShopifyPublication[]> {
  const data = await client.query("publications", PUBLICATIONS_QUERY, {}, publicationsSchema);
  return data.publications.nodes.map((n) => ({ id: n.id, name: (n.name ?? n.catalog?.title ?? "").trim() || "(unnamed)" }));
}

export async function findOnlineStorePublication(client: ShopifyAdminClient): Promise<ShopifyPublication | null> {
  const all = await listPublications(client);
  return all.find((p) => /^online store$/i.test(p.name)) ?? all.find((p) => /online store/i.test(p.name)) ?? null;
}

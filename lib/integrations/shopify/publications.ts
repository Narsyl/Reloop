/**
 * Publications — read the sales channels, find "Online Store", publish a marker product to it.
 * (Recharge's guidance for operational products: UNLISTED + still published to the Online Store.)
 */
import { assertNoUserErrors, productGid, type ShopifyAdminClient } from "./client";
import { publicationsSchema, publishSchema } from "./schemas";
import type { ShopifyPublication } from "./types";

const PUBLICATIONS_QUERY = `query SubscriptionOpsPublications { publications(first: 25) { nodes { id name catalog { title } } } }`;
const PUBLISH_MUTATION = `mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { field message } } }`;

export async function listPublications(client: ShopifyAdminClient): Promise<ShopifyPublication[]> {
  const data = await client.query("publications", PUBLICATIONS_QUERY, {}, publicationsSchema);
  return data.publications.nodes.map((n) => ({ id: n.id, name: (n.name ?? n.catalog?.title ?? "").trim() || "(unnamed)" }));
}

export async function findOnlineStorePublication(client: ShopifyAdminClient): Promise<ShopifyPublication | null> {
  const all = await listPublications(client);
  return all.find((p) => /^online store$/i.test(p.name)) ?? all.find((p) => /online store/i.test(p.name)) ?? null;
}

/** Publish a product to one publication (idempotent on Shopify's side). */
export async function publishProduct(client: ShopifyAdminClient, productId: string, publicationId: string): Promise<void> {
  const data = await client.mutate("publishablePublish", PUBLISH_MUTATION, { id: productGid(productId), input: [{ publicationId }] }, publishSchema);
  assertNoUserErrors("publishablePublish", data.publishablePublish.userErrors);
}

import type { RechargeClient } from "./client";
import { rcProductSchema } from "./schemas";
import { mapProduct } from "./mapper";
import type { ConnectorProduct, ListOptions } from "@/lib/integrations/types";

export async function* listProducts(client: RechargeClient, opts: ListOptions & { startCursor?: string | null } = {}): AsyncGenerator<{ items: ConnectorProduct[]; skipped: number; nextCursor: string | null; page: number }> {
  for await (const page of client.paginate("/products", {
    key: "products",
    itemSchema: rcProductSchema,
    limit: opts.limit ?? 250,
    startCursor: opts.startCursor,
    query: { updated_at_min: opts.updatedSince?.toISOString() },
  })) {
    const items: ConnectorProduct[] = [];
    let skipped = 0;
    for (const raw of page.items) {
      const mapped = mapProduct(raw);
      if (mapped) items.push(mapped);
      else skipped++;
    }
    yield { items, skipped, nextCursor: page.nextCursor, page: page.page };
  }
}

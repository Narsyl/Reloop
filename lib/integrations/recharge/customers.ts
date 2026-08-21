import type { RechargeClient } from "./client";
import { rcCustomerSchema } from "./schemas";
import { mapCustomer } from "./mapper";
import type { ConnectorCustomer, ListOptions } from "@/lib/integrations/types";

export async function* listCustomers(client: RechargeClient, opts: ListOptions & { startCursor?: string | null } = {}): AsyncGenerator<{ items: ConnectorCustomer[]; nextCursor: string | null; page: number }> {
  for await (const page of client.paginate("/customers", {
    key: "customers",
    itemSchema: rcCustomerSchema,
    limit: opts.limit ?? 250,
    startCursor: opts.startCursor,
    query: { updated_at_min: opts.updatedSince?.toISOString() },
  })) {
    yield { items: page.items.map(mapCustomer), nextCursor: page.nextCursor, page: page.page };
  }
}

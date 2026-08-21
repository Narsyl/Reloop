import type { RechargeClient } from "./client";
import { storeEnvelope } from "./schemas";
import { mapStore } from "./mapper";
import type { ConnectorStore } from "@/lib/integrations/types";

/** GET /store — store identity. Also the cheapest authentication check. */
export async function getStore(client: RechargeClient): Promise<ConnectorStore> {
  const data = await client.get("/store", { schema: storeEnvelope });
  return mapStore(data.store);
}

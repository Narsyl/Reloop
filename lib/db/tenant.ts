/**
 * Org-scoped database access.
 *
 * `dbFor(ctx)` returns a Prisma client that injects `organizationId` into every
 * operation on tenant-owned models:
 *   - reads / updates / deletes / counts / aggregates: merged into `where`
 *   - create / createMany / upsert(create): forced into `data`
 *
 * Result: `db.subscription.findUnique({ where: { id } })` can never return
 * another organisation's row, and a create can never be written under the wrong
 * organisation — regardless of what the caller passes.
 *
 * Limits (documented on purpose):
 *   - nested writes (`connect`, nested `create`) are NOT rewritten; domain code
 *     must validate relation ids with a scoped lookup before connecting them.
 *   - `$queryRaw` bypasses this entirely; avoid it for tenant data.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

/** Every model that carries an organizationId column. Keep in sync with schema.prisma. */
export const TENANT_MODELS = [
  "OrganizationMembership",
  "Integration",
  "Customer",
  "Product",
  "ProductVariant",
  "SubscriptionProgram",
  "SubscriptionProgramProduct",
  "FulfillmentMarker",
  "Subscription",
  "SubscriptionJourney",
  "JourneyCycle",
  "AutomationRule",
  "AutomationAction",
  "IntegrationEvent",
  "Exception",
  "ActivityLog",
  "IntegrationSync",
  "SubscriptionOrder",
] as const satisfies readonly Prisma.ModelName[];

const TENANT_MODEL_SET: ReadonlySet<string> = new Set(TENANT_MODELS);

export type TenantModelName = (typeof TENANT_MODELS)[number];

export function isTenantModel(model: string): model is TenantModelName {
  return TENANT_MODEL_SET.has(model);
}

const WHERE_OPS = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
]);

type AnyArgs = Record<string, unknown>;

function scopeWhere(args: AnyArgs, organizationId: string): AnyArgs {
  const where = (args.where ?? {}) as AnyArgs;
  return { ...args, where: { ...where, organizationId } };
}

function scopeData(args: AnyArgs, organizationId: string): AnyArgs {
  const data = args.data;
  if (Array.isArray(data)) {
    return { ...args, data: data.map((d) => ({ ...(d as AnyArgs), organizationId })) };
  }
  return { ...args, data: { ...((data ?? {}) as AnyArgs), organizationId } };
}

export function createTenantClient(organizationId: string) {
  if (!organizationId) throw new Error("createTenantClient: organizationId is required");
  return prisma.$extends({
    name: `tenant:${organizationId}`,
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!isTenantModel(model)) return query(args);
          const a = (args ?? {}) as AnyArgs;
          if (WHERE_OPS.has(operation)) {
            return query(scopeWhere(a, organizationId) as typeof args);
          }
          if (operation === "create" || operation === "createMany" || operation === "createManyAndReturn") {
            return query(scopeData(a, organizationId) as typeof args);
          }
          if (operation === "upsert") {
            const scoped = scopeWhere(a, organizationId);
            scoped.create = { ...((a.create ?? {}) as AnyArgs), organizationId };
            return query(scoped as typeof args);
          }
          return query(args);
        },
      },
    },
  });
}

export type TenantClient = ReturnType<typeof createTenantClient>;

const cache = new Map<string, TenantClient>();

/** Org-scoped client for the given context. Cached per organisation id. */
export function dbFor(ctx: { organizationId: string }): TenantClient {
  let client = cache.get(ctx.organizationId);
  if (!client) {
    client = createTenantClient(ctx.organizationId);
    cache.set(ctx.organizationId, client);
  }
  return client;
}

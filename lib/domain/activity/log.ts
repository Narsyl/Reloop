import "server-only";
import type { ActorType, EntityType, Prisma } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";

export type ActivityInput = {
  actorType: ActorType;
  actorId?: string | null;
  eventType: string;
  entityType: EntityType;
  entityId: string;
  summary: string;
  metadata?: Prisma.InputJsonValue;
};

/**
 * Write one human-readable ActivityLog row for the current organisation.
 * Accepts an optional transaction client so the log lands atomically with the
 * change it describes.
 */
export async function logActivity(
  ctx: { organizationId: string },
  input: ActivityInput,
  tx?: Prisma.TransactionClient,
) {
  const data = {
    organizationId: ctx.organizationId,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    eventType: input.eventType,
    entityType: input.entityType,
    entityId: input.entityId,
    summary: input.summary,
    metadataJson: input.metadata,
  };
  if (tx) return tx.activityLog.create({ data });
  return dbFor(ctx).activityLog.create({ data });
}

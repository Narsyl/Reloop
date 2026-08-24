"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { dbFor } from "@/lib/db/tenant";
import { ForbiddenError, requireRole } from "@/lib/auth/tenancy";
import { logActivity } from "@/lib/domain/activity/log";
import type { ActionResult } from "@/lib/domain/organizations/actions";

const schema = z.object({
  id: z.string().min(1),
  outcome: z.enum(["RESOLVED", "IGNORED"]),
  note: z.string().trim().max(500).optional(),
});

export async function resolveException(input: unknown): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireRole("OPERATOR");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: e.message };
    throw e;
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const { id, outcome, note } = parsed.data;
  const db = dbFor(ctx);
  const existing = await db.exception.findUnique({ where: { id }, select: { id: true, title: true, status: true } });
  if (!existing) return { ok: false, error: "Exception not found." };
  if (existing.status !== "OPEN") return { ok: false, error: "This exception is already closed." };

  await db.exception.update({
    where: { id },
    data: { status: outcome, resolvedAt: new Date(), resolvedById: ctx.userId, resolutionNote: note || null },
  });
  await logActivity(ctx, {
    actorType: "USER",
    actorId: ctx.userId,
    eventType: outcome === "RESOLVED" ? "EXCEPTION_RESOLVED" : "EXCEPTION_IGNORED",
    entityType: "EXCEPTION",
    entityId: id,
    summary: `${outcome === "RESOLVED" ? "Resolved" : "Ignored"} exception: ${existing.title}`,
    metadata: note ? { note } : undefined,
  });
  revalidatePath("/activity");
  revalidatePath("/");
  return { ok: true };
}

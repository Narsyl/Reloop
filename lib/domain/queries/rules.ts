import "server-only";
import { dbFor } from "@/lib/db/tenant";
import type { OrgContext } from "@/lib/auth/tenancy";

type Ctx = Pick<OrgContext, "organizationId">;

export async function listRules(ctx: Ctx) {
  const db = dbFor(ctx);
  const rules = await db.automationRule.findMany({
    where: { status: { not: "ARCHIVED" } },
    orderBy: [{ program: { name: "asc" } }, { cycleNumber: "asc" }],
    include: {
      program: { select: { id: true, name: true, active: true } },
      fulfillmentMarker: { select: { id: true, name: true, active: true, sku: true, title: true, externalVariantId: true } },
      _count: { select: { actions: true } },
    },
  });
  const live = await db.automationAction.groupBy({
    by: ["ruleId"],
    where: { ruleId: { in: rules.map((r) => r.id) }, status: { in: ["PLANNED", "EXECUTING", "ATTACHED"] } },
    _count: { _all: true },
  });
  const liveByRule = new Map(live.map((l) => [l.ruleId, l._count._all]));
  const archived = await db.automationRule.count({ where: { status: "ARCHIVED" } });
  return { rules: rules.map((r) => ({ ...r, liveActions: liveByRule.get(r.id) ?? 0 })), archived };
}

export async function getRule(ctx: Ctx, id: string) {
  const db = dbFor(ctx);
  return db.automationRule.findUnique({
    where: { id },
    include: {
      program: { include: { products: { include: { product: true, variant: true } } } },
      fulfillmentMarker: { include: { variant: { include: { product: true } }, integration: { select: { id: true, displayName: true } } } },
      actions: { orderBy: { createdAt: "desc" }, take: 20, include: { subscription: { include: { customer: true } } } },
    },
  });
}

/** Options for the rule builder. */
export async function getRuleBuilderOptions(ctx: Ctx) {
  const db = dbFor(ctx);
  const [programs, markers, existing] = await Promise.all([
    db.subscriptionProgram.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, description: true, _count: { select: { products: true } } } }),
    db.fulfillmentMarker.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, title: true, sku: true, externalVariantId: true, integrationId: true, integration: { select: { displayName: true } } } }),
    db.automationRule.findMany({ where: { status: { not: "ARCHIVED" } }, select: { id: true, programId: true, cycleNumber: true, name: true, status: true } }),
  ]);
  return { programs, markers, existing };
}

import "server-only";
import { dbFor } from "@/lib/db/tenant";
import type { OrgContext } from "@/lib/auth/tenancy";

type Ctx = Pick<OrgContext, "organizationId">;

export async function listRules(ctx: Ctx) {
  const db = dbFor(ctx);
  const rules = await db.automationRule.findMany({
    orderBy: [{ enabled: "desc" }, { program: { name: "asc" } }, { cycleNumber: "asc" }],
    include: {
      program: { select: { id: true, name: true } },
      fulfillmentMarker: { select: { id: true, name: true, variant: { select: { sku: true, title: true } } } },
      _count: { select: { actions: true } },
    },
  });
  // live actions per rule (what's queued right now)
  const live = await db.automationAction.groupBy({
    by: ["ruleId"],
    where: { ruleId: { in: rules.map((r) => r.id) }, status: { in: ["PLANNED", "EXECUTING", "ATTACHED"] } },
    _count: { _all: true },
  });
  const liveByRule = new Map(live.map((l) => [l.ruleId, l._count._all]));
  return rules.map((r) => ({ ...r, liveActions: liveByRule.get(r.id) ?? 0 }));
}

export async function getRule(ctx: Ctx, id: string) {
  const db = dbFor(ctx);
  const rule = await db.automationRule.findUnique({
    where: { id },
    include: {
      program: { include: { products: { include: { product: true, variant: true } } } },
      fulfillmentMarker: { include: { variant: { include: { product: true } } } },
      actions: {
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { subscription: { include: { customer: true } } },
      },
    },
  });
  return rule;
}

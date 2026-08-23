/**
 * Automation mode per integration — the hard safety boundary.
 *
 *   OFF      nothing is planned or executed
 *   DRY_RUN  actions are planned and validated; the executor only produces previews
 *   LIVE     **unreachable in this phase** — refused server-side regardless of role
 *
 * Defence in depth: even if a row were flipped to LIVE by hand, the connector exposes no write
 * method, so no code path can reach the provider.
 */
import type { AutomationMode } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import { logActivity } from "@/lib/domain/activity/log";

export const REACHABLE_AUTOMATION_MODES: AutomationMode[] = ["OFF", "DRY_RUN"];
export const LIVE_MODE_UNAVAILABLE_MESSAGE = "Live execution is not available in this phase: the action engine runs in dry-run only, and the subscription-platform connector has no write operation. OFF and DRY_RUN are the only reachable modes.";

export async function setIntegrationAutomationMode(
  ctx: { organizationId: string; userId?: string | null },
  integrationId: string,
  mode: AutomationMode,
): Promise<{ ok: true; previous: AutomationMode; mode: AutomationMode } | { ok: false; error: string }> {
  if (!REACHABLE_AUTOMATION_MODES.includes(mode)) return { ok: false, error: LIVE_MODE_UNAVAILABLE_MESSAGE };
  const db = dbFor(ctx);
  const integration = await db.integration.findUnique({ where: { id: integrationId }, select: { id: true, status: true, automationMode: true, displayName: true } });
  if (!integration) return { ok: false, error: "Integration not found in this organisation." };
  if (mode === "DRY_RUN" && integration.status !== "CONNECTED") return { ok: false, error: "The integration must be connected before dry-run planning can be enabled." };
  if (integration.automationMode === mode) return { ok: true, previous: mode, mode };
  await db.integration.update({ where: { id: integrationId }, data: { automationMode: mode } });
  await logActivity(ctx, {
    actorType: ctx.userId ? "USER" : "SYSTEM",
    actorId: ctx.userId ?? null,
    eventType: "INTEGRATION_AUTOMATION_MODE_CHANGED",
    entityType: "INTEGRATION",
    entityId: integrationId,
    summary: `Automation mode for ${integration.displayName}: ${integration.automationMode} → ${mode}${mode === "DRY_RUN" ? " (planning + dry-run previews only; nothing is written to the subscription platform)" : ""}`,
    metadata: { previous: integration.automationMode, mode },
  });
  return { ok: true, previous: integration.automationMode, mode };
}

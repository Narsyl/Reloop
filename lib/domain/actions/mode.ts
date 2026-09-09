/**
 * Automation mode per integration — the hard safety boundary.
 *
 *   OFF      nothing is planned or executed
 *   DRY_RUN  actions are planned and validated; the executor only produces previews
 *   LIVE     due actions execute through the full engine: fresh preflight, atomic claim,
 *            verified-binding gate, single POST, read reconciliation, authoritative read-back
 */
import type { AutomationMode } from "@prisma/client";
import { dbFor } from "@/lib/db/tenant";
import { logActivity } from "@/lib/domain/activity/log";

export const REACHABLE_AUTOMATION_MODES: AutomationMode[] = ["OFF", "DRY_RUN", "LIVE"];
export const LIVE_MODE_UNAVAILABLE_MESSAGE = "That automation mode is not available.";

export async function setIntegrationAutomationMode(
  ctx: { organizationId: string; userId?: string | null },
  integrationId: string,
  mode: AutomationMode,
): Promise<{ ok: true; previous: AutomationMode; mode: AutomationMode } | { ok: false; error: string }> {
  if (!REACHABLE_AUTOMATION_MODES.includes(mode)) return { ok: false, error: LIVE_MODE_UNAVAILABLE_MESSAGE };
  const db = dbFor(ctx);
  const integration = await db.integration.findUnique({ where: { id: integrationId }, select: { id: true, status: true, automationMode: true, displayName: true } });
  if (!integration) return { ok: false, error: "Integration not found in this organisation." };
  if (mode !== "OFF" && integration.status !== "CONNECTED") return { ok: false, error: "The integration must be connected before automation can be enabled." };
  if (integration.automationMode === mode) return { ok: true, previous: mode, mode };
  await db.integration.update({ where: { id: integrationId }, data: { automationMode: mode } });
  await logActivity(ctx, {
    actorType: ctx.userId ? "USER" : "SYSTEM",
    actorId: ctx.userId ?? null,
    eventType: "INTEGRATION_AUTOMATION_MODE_CHANGED",
    entityType: "INTEGRATION",
    entityId: integrationId,
    summary: `Automation mode for ${integration.displayName}: ${integration.automationMode} → ${mode}${mode === "DRY_RUN" ? " (planning + dry-run previews only; nothing is written to the subscription platform)" : mode === "LIVE" ? " (due gifts now execute automatically: fresh preflight, verified bindings only, read-back verification)" : ""}`,
    metadata: { previous: integration.automationMode, mode },
  });
  return { ok: true, previous: integration.automationMode, mode };
}

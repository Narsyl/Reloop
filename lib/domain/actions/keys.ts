/**
 * Idempotency keys for AutomationAction (pure).
 *
 *  liveKey  — §10 "action gate": `<journeyId>:<targetCycle>:<fulfillmentMarkerId>` while the action is
 *             live (PLANNED / EXECUTING / ATTACHED / FULFILLED / FAILED); NULL when CANCELLED / SUPERSEDED.
 *             The physical invariant: this marker ships at most once per journey-cycle.
 *  ownerKey — Phase 4: the rule SCOPE's milestone owner, same lifetime as liveKey:
 *             PER_SUBSCRIPTION  → `j:<journeyId>:<cycle>:<markerId>`
 *             CUSTOMER_PROGRAM  → `c:<customerId>:<programId>:<cycle>:<markerId>`
 *             so a customer can own a customer-programme milestone at most once even across journeys.
 *
 * Both are UNIQUE columns; the planner relies on the database to arbitrate concurrent inserts
 * (create → P2002 → treat as "already planned"), never on find-then-create.
 */
import type { ActionStatus, EligibilityScope } from "@prisma/client";

export const LIVE_ACTION_STATUSES: ActionStatus[] = ["PLANNED", "EXECUTING", "ATTACHED", "FULFILLED", "FAILED"];
export const KEY_FREEING_STATUSES: ActionStatus[] = ["CANCELLED", "SUPERSEDED"];

export function liveKeyFor(journeyId: string, targetCycle: number, fulfillmentMarkerId: string): string {
  return `${journeyId}:${targetCycle}:${fulfillmentMarkerId}`;
}

export function ownerKeyFor(input: { scope: EligibilityScope; journeyId: string; customerId: string | null; programId: string; targetCycle: number; fulfillmentMarkerId: string }): string {
  if (input.scope === "CUSTOMER_PROGRAM" && input.customerId) return `c:${input.customerId}:${input.programId}:${input.targetCycle}:${input.fulfillmentMarkerId}`;
  // PER_SUBSCRIPTION (or a customer-programme rule on a subscription without a customer link): journey-level
  return `j:${input.journeyId}:${input.targetCycle}:${input.fulfillmentMarkerId}`;
}

export function isLiveStatus(status: ActionStatus): boolean {
  return LIVE_ACTION_STATUSES.includes(status);
}

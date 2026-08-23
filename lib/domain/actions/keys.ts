/**
 * Idempotency keys for AutomationAction (pure).
 *
 *  liveKey  — §10 "action gate": `<journeyId>:<targetCycle>:<rewardItemId>` while the action is
 *             live (PLANNED / EXECUTING / ATTACHED / FULFILLED / FAILED); NULL when CANCELLED / SUPERSEDED.
 *             The physical invariant: this reward ships at most once per journey-cycle. (Legacy rule-planned
 *             actions used the marker id in the same position.)
 *  ownerKey — Phase 4: the rule SCOPE's milestone owner, same lifetime as liveKey:
 *             PER_SUBSCRIPTION  → `j:<journeyId>:<cycle>:<rewardItemId>`
 *             CUSTOMER_PROGRAM  → `c:<customerId>:<programId>:<cycle>:<rewardItemId>`
 *             so a customer can own a customer-programme milestone at most once even across journeys.
 *
 * Both are UNIQUE columns; the planner relies on the database to arbitrate concurrent inserts
 * (create → P2002 → treat as "already planned"), never on find-then-create.
 */
import type { ActionStatus, EligibilityScope } from "@prisma/client";

export const LIVE_ACTION_STATUSES: ActionStatus[] = ["PLANNED", "EXECUTING", "ATTACHED", "FULFILLED", "FAILED"];
export const KEY_FREEING_STATUSES: ActionStatus[] = ["CANCELLED", "SUPERSEDED"];

/** `rewardId` = RewardItem id for schedule-planned actions (legacy: FulfillmentMarker id). */
export function liveKeyFor(journeyId: string, targetCycle: number, rewardId: string): string {
  return `${journeyId}:${targetCycle}:${rewardId}`;
}

export function ownerKeyFor(input: { scope: EligibilityScope; journeyId: string; customerId: string | null; programId: string; targetCycle: number; rewardId: string }): string {
  if (input.scope === "CUSTOMER_PROGRAM" && input.customerId) return `c:${input.customerId}:${input.programId}:${input.targetCycle}:${input.rewardId}`;
  // PER_SUBSCRIPTION (or a customer-programme rule on a subscription without a customer link): journey-level
  return `j:${input.journeyId}:${input.targetCycle}:${input.rewardId}`;
}

export function isLiveStatus(status: ActionStatus): boolean {
  return LIVE_ACTION_STATUSES.includes(status);
}

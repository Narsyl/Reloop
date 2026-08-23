/**
 * The ONE place that writes AutomationAction.status (§10): transitions that free the milestone
 * (CANCELLED / SUPERSEDED) null liveKey + ownerKey in the same statement, so the keys can never
 * outlive the status. Everything else that changes an action's state must go through here.
 */
import type { ActionStatus, Prisma } from "@prisma/client";
import { KEY_FREEING_STATUSES } from "./keys";

export type ActionCancelReason =
  | "SUBSCRIPTION_NOT_ACTIVE"
  | "NO_UPCOMING_CHARGE"
  | "JOURNEY_ENDED"
  | "PROGRAM_CHANGED"
  | "MAPPING_BROKEN"
  | "RULE_NOT_READY"
  | "MARKER_UNAVAILABLE"
  | "CUSTOMER_ALREADY_REACHED_MILESTONE"
  | "MILESTONE_PASSED"
  | "NO_LONGER_QUALIFIES"
  | "AUTOMATION_OFF"
  | "MANUAL";

export const CANCEL_REASON_LABEL: Record<ActionCancelReason, string> = {
  SUBSCRIPTION_NOT_ACTIVE: "Subscription no longer active",
  NO_UPCOMING_CHARGE: "No upcoming charge to attach to",
  JOURNEY_ENDED: "Journey ended",
  PROGRAM_CHANGED: "Subscription moved to a different programme",
  MAPPING_BROKEN: "Programme mapping no longer resolves",
  RULE_NOT_READY: "Rule no longer ready / active",
  MARKER_UNAVAILABLE: "Marker inactive or placeholder",
  CUSTOMER_ALREADY_REACHED_MILESTONE: "Customer already reached this milestone on another subscription",
  MILESTONE_PASSED: "Target delivery processed without the marker (automation was not live)",
  NO_LONGER_QUALIFIES: "No longer qualifies for the rule",
  AUTOMATION_OFF: "Automation switched off",
  MANUAL: "Cancelled by an operator",
};

/** Structural writer type so both the plain TransactionClient and the tenant-extended client fit. */
type Tx = { automationAction: { update(args: { where: { id: string }; data: Prisma.AutomationActionUncheckedUpdateInput }): Promise<unknown> } };

export async function transitionAction(
  tx: Tx,
  actionId: string,
  to: Extract<ActionStatus, "CANCELLED" | "SUPERSEDED">,
  opts: { reason: ActionCancelReason; detail?: string; supersededById?: string },
) {
  if (!KEY_FREEING_STATUSES.includes(to)) throw new Error(`transitionAction: unsupported target status ${to} in Phase 4`);
  return tx.automationAction.update({
    where: { id: actionId },
    data: {
      status: to,
      liveKey: null,
      ownerKey: null,
      cancelReason: opts.detail ? `${opts.reason}: ${opts.detail}` : opts.reason,
      supersededById: opts.supersededById ?? null,
    },
  });
}

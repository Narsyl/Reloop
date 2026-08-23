/**
 * Layer B — RULE QUALIFICATION (pure, no I/O).
 *
 * "Does this operationally-eligible journey qualify for THIS rule?"
 * Assumes layer A (evaluate.ts) already passed; callers combine both.
 */
import type { EligibilityScope, RuleStatus } from "@prisma/client";

export type DisqualificationReason =
  | "RULE_NOT_ACTIVE"
  | "WRONG_PROGRAM"
  | "MILESTONE_ALREADY_PASSED" // journey is beyond the milestone
  | "NOT_NEXT_CYCLE" // journey is before cycle-1 of the milestone (future-only)
  | "SCOPE_NOT_CHOSEN"
  | "CUSTOMER_ALREADY_REACHED_MILESTONE" // CUSTOMER_PROGRAM: lifetime deliveries already ≥ milestone
  | "ACTION_EXISTS";

export const DISQUALIFICATION_LABEL: Record<DisqualificationReason, string> = {
  RULE_NOT_ACTIVE: "Rule is not ready or active",
  WRONG_PROGRAM: "Different programme",
  MILESTONE_ALREADY_PASSED: "Already past this delivery",
  NOT_NEXT_CYCLE: "Not yet at the delivery before the milestone (future-only)",
  SCOPE_NOT_CHOSEN: "Eligibility scope not chosen on the rule",
  CUSTOMER_ALREADY_REACHED_MILESTONE: "Customer already reached this milestone on an earlier subscription",
  ACTION_EXISTS: "An action already owns this milestone",
};

export type QualificationInput = {
  rule: { status: RuleStatus; programId: string; cycleNumber: number; eligibilityScope: EligibilityScope | null };
  journey: { programId: string; successfulCycles: number };
  /**
   * CUSTOMER_PROGRAM only: distinct successful deliveries of the same provider
   * customer in this programme across ALL their journeys (including this one and
   * ended/cancelled ones). Must be computed from distinct JourneyCycle evidence.
   */
  customerLifetimeDeliveries?: number;
  /** a live AutomationAction already exists for (journey, targetCycle, marker) */
  existingLiveAction?: boolean;
  /** evaluate as if the rule were active (impact preview) */
  ignoreRuleStatus?: boolean;
  /** planner: READY rules are usable ("configuration valid, may be planned/dry-run"); ACTIVE stays unreachable until the live phase */
  allowReady?: boolean;
  /** evaluate under a scope other than the rule's (impact preview comparison) */
  scopeOverride?: EligibilityScope;
};

export type QualificationResult =
  | { qualifies: true; timing: "NOW" }
  | { qualifies: false; reason: DisqualificationReason; timing: "FUTURE" | "NEVER" | "BLOCKED" };

export function qualifyForRule(input: QualificationInput): QualificationResult {
  const { rule, journey } = input;
  const scope = input.scopeOverride ?? rule.eligibilityScope;
  const ruleUsable = rule.status === "ACTIVE" || (input.allowReady === true && rule.status === "READY");
  if (!input.ignoreRuleStatus && !ruleUsable) return { qualifies: false, reason: "RULE_NOT_ACTIVE", timing: "BLOCKED" };
  if (journey.programId !== rule.programId) return { qualifies: false, reason: "WRONG_PROGRAM", timing: "NEVER" };
  if (!scope) return { qualifies: false, reason: "SCOPE_NOT_CHOSEN", timing: "BLOCKED" };
  const next = journey.successfulCycles + 1;
  if (next > rule.cycleNumber) return { qualifies: false, reason: "MILESTONE_ALREADY_PASSED", timing: "NEVER" };
  if (scope === "CUSTOMER_PROGRAM") {
    const lifetime = input.customerLifetimeDeliveries ?? journey.successfulCycles;
    // The customer's NEXT lifetime delivery is lifetime + 1; the milestone is reached when
    // that equals the rule cycle. If they are already beyond it, the reward is not due again.
    if (lifetime + 1 > rule.cycleNumber) return { qualifies: false, reason: "CUSTOMER_ALREADY_REACHED_MILESTONE", timing: "NEVER" };
    if (lifetime + 1 < rule.cycleNumber) return { qualifies: false, reason: "NOT_NEXT_CYCLE", timing: "FUTURE" };
    // A subscription's FIRST shipment is never a renewal: the renewal planner only attaches milestones
    // to a journey that has completed at least one delivery (delivery 1 is INITIAL_CHECKOUT territory).
    // This also makes the customer milestone land deterministically on the journey actually at a renewal.
    if (journey.successfulCycles < 1) return { qualifies: false, reason: "NOT_NEXT_CYCLE", timing: "FUTURE" };
  } else if (next < rule.cycleNumber) {
    return { qualifies: false, reason: "NOT_NEXT_CYCLE", timing: "FUTURE" };
  }
  if (input.existingLiveAction) return { qualifies: false, reason: "ACTION_EXISTS", timing: "BLOCKED" };
  return { qualifies: true, timing: "NOW" };
}

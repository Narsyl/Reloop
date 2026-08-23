/**
 * Rule configuration validation (pure). Shared by the server actions and the UI
 * so the explanations are identical everywhere.
 */
import type { EligibilityScope } from "@prisma/client";

export const MIN_RULE_CYCLE = 2;

export const CYCLE_ONE_EXPLANATION =
  "Delivery 1 occurs at subscription checkout, before milestone automation can schedule an upcoming shipment. Milestone rules begin at delivery 2.";

export type RuleConfigInput = {
  name: string;
  programId: string | null;
  cycleNumber: number | null;
  fulfillmentMarkerId: string | null;
  eligibilityScope: EligibilityScope | null;
};

export type RuleValidationIssue = { field: keyof RuleConfigInput | "general"; code: string; message: string; blocksReady: boolean };

/** Issues that block saving a DRAFT vs issues that only block READY. */
export function validateRuleConfig(input: RuleConfigInput): RuleValidationIssue[] {
  const issues: RuleValidationIssue[] = [];
  if (!input.name || input.name.trim().length < 2) issues.push({ field: "name", code: "NAME_REQUIRED", message: "Give the rule a name.", blocksReady: true });
  if (!input.programId) issues.push({ field: "programId", code: "PROGRAM_REQUIRED", message: "Choose a subscription programme.", blocksReady: true });
  if (input.cycleNumber === null || !Number.isInteger(input.cycleNumber)) issues.push({ field: "cycleNumber", code: "CYCLE_REQUIRED", message: "Choose the delivery cycle.", blocksReady: true });
  else if (input.cycleNumber < MIN_RULE_CYCLE) issues.push({ field: "cycleNumber", code: "CYCLE_TOO_LOW", message: CYCLE_ONE_EXPLANATION, blocksReady: true });
  else if (input.cycleNumber > 60) issues.push({ field: "cycleNumber", code: "CYCLE_TOO_HIGH", message: "Delivery cycle must be 60 or lower.", blocksReady: true });
  if (!input.fulfillmentMarkerId) issues.push({ field: "fulfillmentMarkerId", code: "MARKER_REQUIRED", message: "Choose the fulfilment marker to add.", blocksReady: true });
  if (!input.eligibilityScope) issues.push({ field: "eligibilityScope", code: "SCOPE_REQUIRED", message: "Choose who counts towards this milestone (per subscription or customer programme) before the rule can be ready.", blocksReady: true });
  return issues;
}

export function milestoneKey(organizationId: string, programId: string, cycleNumber: number): string {
  return `${organizationId}:${programId}:${cycleNumber}`;
}

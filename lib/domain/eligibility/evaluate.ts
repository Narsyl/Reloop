/**
 * Layer A — OPERATIONAL ELIGIBILITY (pure, no I/O).
 *
 * "Is this subscription/journey operationally capable of receiving automation at all?"
 * Independent of any rule. Returns a structured result with a reason code so the
 * impact preview, Upcoming, Exceptions, dry-run and the future planner can all say
 * *why* something is excluded — never a bare boolean.
 *
 * Layer B (rule qualification) lives in ./qualify.ts.
 */
import type { AutomationMode, IntegrationStatus, MappingStatus, SubscriptionStatus } from "@prisma/client";

export type IneligibilityReason =
  | "SUBSCRIPTION_NOT_ACTIVE"
  | "NO_JOURNEY"
  | "NOT_LATEST_JOURNEY"
  | "JOURNEY_ENDED"
  | "UNMAPPED"
  | "BROKEN_MAPPING"
  | "NO_UPCOMING_CHARGE"
  | "INTEGRATION_NOT_CONNECTED"
  | "AUTOMATION_OFF"
  | "BLOCKING_EXCEPTION";

export type EligibilityResult = { eligible: true; reasons: [] } | { eligible: false; reason: IneligibilityReason; reasons: IneligibilityReason[] };

export type EligibilityInput = {
  subscription: {
    status: SubscriptionStatus;
    mappingStatus: MappingStatus;
    nextChargeDate: string | null;
    latestJourneyId: string | null;
    automationOverride?: "ENABLED" | "DISABLED" | null;
  };
  /** the journey being evaluated (usually the latest) */
  journey: { id: string; endedAt: Date | null; programId: string } | null;
  /** result of resolving the subscription's CURRENT product/variant to a programme; null = unresolvable */
  resolvedProgramId: string | null;
  integration: { status: IntegrationStatus; automationMode: AutomationMode };
  /** open exceptions of a blocking type for this subscription (Phase 4+ defines the set; empty for now) */
  blockingExceptions?: number;
};

export const INELIGIBILITY_LABEL: Record<IneligibilityReason, string> = {
  SUBSCRIPTION_NOT_ACTIVE: "Subscription is not active",
  NO_JOURNEY: "No programme journey",
  NOT_LATEST_JOURNEY: "Not the latest journey",
  JOURNEY_ENDED: "Journey has ended",
  UNMAPPED: "Product not assigned to a programme",
  BROKEN_MAPPING: "Programme mapping no longer resolves",
  NO_UPCOMING_CHARGE: "No upcoming charge",
  INTEGRATION_NOT_CONNECTED: "Integration not connected",
  AUTOMATION_OFF: "Automation is off for this integration",
  BLOCKING_EXCEPTION: "Blocked by an open exception",
};

/**
 * All conditions are checked and reported (reasons[]), with `reason` = the most
 * fundamental one, so operators see the full picture rather than the first failure.
 */
export function evaluateJourneyEligibility(input: EligibilityInput): EligibilityResult {
  const reasons: IneligibilityReason[] = [];
  const { subscription: s, journey, integration } = input;

  if (s.status !== "ACTIVE") reasons.push("SUBSCRIPTION_NOT_ACTIVE");
  if (!journey) reasons.push("NO_JOURNEY");
  else {
    if (s.latestJourneyId !== journey.id) reasons.push("NOT_LATEST_JOURNEY");
    if (journey.endedAt) reasons.push("JOURNEY_ENDED");
  }
  if (s.mappingStatus !== "MAPPED") reasons.push("UNMAPPED");
  else if (journey && (input.resolvedProgramId === null || input.resolvedProgramId !== journey.programId)) reasons.push("BROKEN_MAPPING");
  if (!s.nextChargeDate) reasons.push("NO_UPCOMING_CHARGE");
  if (integration.status !== "CONNECTED") reasons.push("INTEGRATION_NOT_CONNECTED");
  if (integration.automationMode === "OFF" && s.automationOverride !== "ENABLED") reasons.push("AUTOMATION_OFF");
  if (s.automationOverride === "DISABLED" && !reasons.includes("AUTOMATION_OFF")) reasons.push("AUTOMATION_OFF");
  if ((input.blockingExceptions ?? 0) > 0) reasons.push("BLOCKING_EXCEPTION");

  if (reasons.length === 0) return { eligible: true, reasons: [] };
  return { eligible: false, reason: reasons[0], reasons };
}

/**
 * Operational eligibility WITHOUT the integration-mode gate. Used by impact
 * analysis so a merchant can see "would qualify once automation is on" while the
 * integration is still OFF (Phase 3 = configuration, not execution).
 */
export function evaluateJourneyEligibilityIgnoringMode(input: EligibilityInput): EligibilityResult {
  const r = evaluateJourneyEligibility({ ...input, integration: { ...input.integration, automationMode: "DRY_RUN" }, subscription: { ...input.subscription, automationOverride: input.subscription.automationOverride === "DISABLED" ? "DISABLED" : null } });
  return r;
}

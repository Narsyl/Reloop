/**
 * The single source of truth for status → label + tone.
 * Components never define their own status colours; they call these.
 *
 * Tones map to semantic tokens in globals.css:
 *   success  healthy / complete
 *   warning  needs awareness
 *   danger   failed / action required
 *   info     informational / in progress
 *   neutral  pending / inactive
 */
import type {
  RewardScheduleStatus,
  MilestoneExecutionMode,
  ActionStatus,
  AutomationMode,
  EligibilityScope,
  RuleStatus,
  ExceptionSeverity,
  ExceptionStatus,
  IntegrationEventStatus,
  IntegrationStatus,
  MappingStatus,
  SubscriptionStatus,
} from "@prisma/client";

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

export type StatusMeta = { label: string; tone: Tone; description?: string };

export const subscriptionStatus: Record<SubscriptionStatus, StatusMeta> = {
  ACTIVE: { label: "Active", tone: "success" },
  PAUSED: { label: "Paused", tone: "warning" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
  EXPIRED: { label: "Expired", tone: "neutral" },
  UNKNOWN: { label: "Unknown", tone: "warning" },
};

export const actionStatus: Record<ActionStatus, StatusMeta> = {
  PLANNED: { label: "Scheduled", tone: "info", description: "The gift will be added closer to the renewal." },
  EXECUTING: { label: "Adding", tone: "info", description: "The gift is being added to the renewal now." },
  ATTACHED: { label: "Added", tone: "success", description: "The gift is on the upcoming renewal." },
  FULFILLED: { label: "Delivered", tone: "success", description: "The gift shipped with the renewal order." },
  FAILED: { label: "Needs review", tone: "danger", description: "Something stopped this gift. Open it to see why." },
  CANCELLED: { label: "Skipped", tone: "neutral", description: "This gift no longer applies." },
  SUPERSEDED: { label: "Replaced", tone: "neutral", description: "The journey changed and a newer gift took its place." },
};

export const exceptionSeverity: Record<ExceptionSeverity, StatusMeta> = {
  INFO: { label: "Info", tone: "info" },
  WARNING: { label: "Warning", tone: "warning" },
  CRITICAL: { label: "Critical", tone: "danger" },
};

export const exceptionStatus: Record<ExceptionStatus, StatusMeta> = {
  OPEN: { label: "Open", tone: "warning" },
  RESOLVED: { label: "Resolved", tone: "success" },
  IGNORED: { label: "Ignored", tone: "neutral" },
};

export const integrationStatus: Record<IntegrationStatus, StatusMeta> = {
  CONNECTED: { label: "Connected", tone: "success" },
  ERROR: { label: "Error", tone: "danger" },
  DISCONNECTED: { label: "Not connected", tone: "neutral" },
};

export const automationMode: Record<AutomationMode, StatusMeta> = {
  OFF: { label: "Off", tone: "neutral", description: "Nothing is scheduled and nothing is written to Recharge." },
  DRY_RUN: { label: "Test mode", tone: "info", description: "Every gift is rehearsed and previewed. Nothing is written to Recharge." },
  LIVE: { label: "Live", tone: "success", description: "Gifts are added automatically. Not available yet." },
};

export const eventStatus: Record<IntegrationEventStatus, StatusMeta> = {
  RECEIVED: { label: "Received", tone: "neutral" },
  PROCESSING: { label: "Processing", tone: "info" },
  PROCESSED: { label: "Processed", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
  IGNORED: { label: "Ignored", tone: "neutral" },
};

export const mappingStatus: Record<MappingStatus, StatusMeta> = {
  MAPPED: { label: "In a programme", tone: "success" },
  UNMAPPED: { label: "No programme", tone: "warning", description: "This product is not part of a programme yet, so it has no reward journey." },
};

export const enabledStatus = (enabled: boolean): StatusMeta =>
  enabled ? { label: "Enabled", tone: "success" } : { label: "Disabled", tone: "neutral" };

export const ruleStatus: Record<RuleStatus, StatusMeta> = {
  DRAFT: { label: "Draft", tone: "neutral", description: "Being configured. Cannot plan actions." },
  READY: { label: "Ready", tone: "info", description: "Valid and complete: the dry-run planner plans actions for it and previews what would be sent. Nothing is attached until the live phase." },
  ACTIVE: { label: "Active", tone: "success", description: "Live automation (not available in this phase)." },
  DISABLED: { label: "Disabled", tone: "neutral", description: "Intentionally off." },
  ARCHIVED: { label: "Archived", tone: "neutral", description: "Retired; its milestone is free for a new rule." },
};

export const eligibilityScopeLabel: Record<EligibilityScope, { label: string; description: string }> = {
  PER_SUBSCRIPTION: { label: "Once per subscription", description: "Each subscription starts the journey again. A returning customer can receive the same reward on a new subscription." },
  CUSTOMER_PROGRAM: { label: "Once per customer", description: "All of a customer's deliveries in this programme count together, so each reward is given once even across new subscriptions." },
};

/** Operational scheduling state derived from provider data — never invented as a status. */
export const schedulingState = (status: SubscriptionStatus, nextChargeDate: string | null): StatusMeta | null =>
  status === "ACTIVE" && !nextChargeDate ? { label: "No upcoming charge", tone: "warning", description: "Active in the platform but nothing is scheduled (e.g. retries exhausted). Ineligible for planned markers until a charge is scheduled again." } : null;

export const activeStatus = (active: boolean): StatusMeta =>
  active ? { label: "Active", tone: "success" } : { label: "Inactive", tone: "neutral" };

/** Eligibility / risk state of a planned action from its last dry run. */
export function dryRunState(a: { status: ActionStatus; lastDryRunAt: Date | null; wouldExecute: boolean | null; blockingReason: string | null; executeAfter: Date | null }, now = new Date()): StatusMeta {
  if (a.status !== "PLANNED") return actionStatus[a.status];
  if (a.lastDryRunAt && a.wouldExecute === true) return { label: "Verified", tone: "success", description: "The latest check against Recharge passed every step." };
  if (a.lastDryRunAt && a.wouldExecute === false) return { label: "Needs review", tone: "warning", description: blockerSentence(a.blockingReason) };
  if (a.executeAfter && a.executeAfter.getTime() <= now.getTime()) return { label: "Checking soon", tone: "info", description: "The next automatic check will verify this gift against Recharge." };
  return { label: "Scheduled", tone: "neutral", description: "The gift will be checked and added closer to the renewal." };
}

/** Plain sentence for a stored dry run blocking reason. The raw reason stays in technical details. */
export function blockerSentence(reason: string | null | undefined): string {
  const code = reason?.split(":")[0]?.trim();
  switch (code) {
    case "TARGET_CHARGE_MOVED":
      return "The renewal date moved. The gift will be rescheduled after the next sync.";
    case "EXTERNAL_SUBSCRIPTION_NOT_ACTIVE":
    case "SUBSCRIPTION_NOT_ACTIVE":
      return "The subscription is no longer active in Recharge.";
    case "EXTERNAL_NO_UPCOMING_CHARGE":
    case "NO_UPCOMING_CHARGE":
      return "There is no upcoming renewal to attach the gift to.";
    case "REWARD_UNBOUND":
      return "The reward is not linked to a Shopify product yet.";
    case "BINDING_VARIANT_MISSING":
      return "The linked Shopify product is missing or unavailable.";
    case "MILESTONE_NOT_READY":
      return "The reward journey for this step is not ready.";
    case "EXTERNAL_READ_FAILED":
      return "Recharge could not be reached during the last check. It will be retried.";
    case "CUSTOMER_ALREADY_REACHED_MILESTONE":
      return "This customer already received this reward.";
    case "MILESTONE_ALREADY_PASSED":
    case "JOURNEY_NOT_AT_PREVIOUS_DELIVERY":
      return "The delivery this gift was meant for has already happened.";
    default:
      return reason ? "The latest check did not pass. The technical details show the reason." : "This gift needs a look.";
  }
}

export const rewardScheduleStatus: Record<RewardScheduleStatus, StatusMeta> = {
  DRAFT: { label: "Draft", tone: "neutral", description: "Being configured. The planner ignores it." },
  READY: { label: "Ready", tone: "info", description: "Configuration signed off: the dry-run planner plans its renewal milestones for every programme with a real marker bound." },
  ARCHIVED: { label: "Archived", tone: "neutral", description: "Retired." },
};

export const executionModeLabel: Record<MilestoneExecutionMode, { label: string; description: string }> = {
  UPCOMING_RENEWAL: { label: "Upcoming renewal", description: "Planned before a future charge by the renewal planner." },
  INITIAL_CHECKOUT: { label: "Initial checkout", description: "Part of the first order by construction (starter product / checkout rule). Recorded here; never planned by the renewal planner." },
};

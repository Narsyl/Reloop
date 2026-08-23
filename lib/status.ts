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
  PLANNED: { label: "Planned", tone: "info", description: "Decided; marker not yet attached in the subscription platform." },
  EXECUTING: { label: "Attaching", tone: "info", description: "Attaching the marker now." },
  ATTACHED: { label: "Attached", tone: "success", description: "Marker is on the upcoming shipment." },
  FULFILLED: { label: "Fulfilled", tone: "success", description: "The shipment processed with the marker." },
  FAILED: { label: "Failed", tone: "danger", description: "Needs attention — see Exceptions." },
  CANCELLED: { label: "Cancelled", tone: "neutral", description: "No longer applicable." },
  SUPERSEDED: { label: "Superseded", tone: "neutral", description: "Replaced by a newer action." },
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
  OFF: { label: "Automation off", tone: "neutral", description: "Nothing is written to the subscription platform." },
  DRY_RUN: { label: "Dry run", tone: "info", description: "Actions are planned, dry-run and previewed; nothing is written to the subscription platform." },
  LIVE: { label: "Live", tone: "success", description: "Markers are attached automatically (not available in this phase)." },
};

export const eventStatus: Record<IntegrationEventStatus, StatusMeta> = {
  RECEIVED: { label: "Received", tone: "neutral" },
  PROCESSING: { label: "Processing", tone: "info" },
  PROCESSED: { label: "Processed", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
  IGNORED: { label: "Ignored", tone: "neutral" },
};

export const mappingStatus: Record<MappingStatus, StatusMeta> = {
  MAPPED: { label: "Mapped", tone: "success" },
  UNMAPPED: { label: "Unmapped", tone: "warning", description: "Product is not assigned to a subscription program." },
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
  PER_SUBSCRIPTION: { label: "Per subscription", description: "Each subscription restarts milestone eligibility. A returning customer's new subscription can qualify again." },
  CUSTOMER_PROGRAM: { label: "Customer programme", description: "Lifetime deliveries of the same customer in this programme count, across cancelled and new subscriptions." },
};

/** Operational scheduling state derived from provider data — never invented as a status. */
export const schedulingState = (status: SubscriptionStatus, nextChargeDate: string | null): StatusMeta | null =>
  status === "ACTIVE" && !nextChargeDate ? { label: "No upcoming charge", tone: "warning", description: "Active in the platform but nothing is scheduled (e.g. retries exhausted). Ineligible for planned markers until a charge is scheduled again." } : null;

export const activeStatus = (active: boolean): StatusMeta =>
  active ? { label: "Active", tone: "success" } : { label: "Inactive", tone: "neutral" };

/** Eligibility / risk state of a planned action from its last dry run. */
export function dryRunState(a: { status: ActionStatus; lastDryRunAt: Date | null; wouldExecute: boolean | null; blockingReason: string | null; executeAfter: Date | null }, now = new Date()): StatusMeta {
  if (a.status !== "PLANNED") return actionStatus[a.status];
  if (a.lastDryRunAt && a.wouldExecute === true) return { label: "Would execute", tone: "success", description: "Last dry run passed every check." };
  if (a.lastDryRunAt && a.wouldExecute === false) return { label: a.blockingReason ? "Blocked · " + a.blockingReason.split(":")[0] : "Blocked", tone: "warning", description: a.blockingReason ?? undefined };
  if (a.executeAfter && a.executeAfter.getTime() <= now.getTime()) return { label: "Due · awaiting dry run", tone: "info" };
  return { label: "Scheduled", tone: "neutral", description: "Dry run happens when the execute-after time is reached (or on demand)." };
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

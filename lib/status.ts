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
  ActionStatus,
  AutomationMode,
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
  DRY_RUN: { label: "Dry run", tone: "info", description: "Actions are planned and validated but not attached." },
  LIVE: { label: "Live", tone: "success", description: "Markers are attached automatically." },
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

export const activeStatus = (active: boolean): StatusMeta =>
  active ? { label: "Active", tone: "success" } : { label: "Inactive", tone: "neutral" };

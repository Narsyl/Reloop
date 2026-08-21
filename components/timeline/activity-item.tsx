import type { ActivityLog } from "@prisma/client";
import { TimelineItem } from "@/components/timeline/timeline";
import { formatDateTime, formatRelative } from "@/lib/format";
import type { Tone } from "@/lib/status";

/** Map of activity event types → tone. Unknown types are neutral. */
const TONES: Record<string, Tone> = {
  ACTION_FAILED: "danger",
  EXCEPTION_OPENED: "warning",
  EXCEPTION_RESOLVED: "success",
  EXCEPTION_IGNORED: "neutral",
  MARKER_ATTACHED: "success",
  MARKER_FULFILLED: "success",
  MARKER_QUEUED: "info",
  MARKER_MOVED: "warning",
  MARKER_REMOVED: "warning",
  ACTION_CANCELLED: "neutral",
  CYCLE_COMPLETED: "success",
  RULE_ENABLED: "success",
  RULE_DISABLED: "neutral",
  RULE_CREATED: "info",
  INTEGRATION_CONNECTED: "success",
  INTEGRATION_ERROR: "danger",
  SUBSCRIPTION_SWAPPED: "warning",
  SUBSCRIPTION_CANCELLED: "neutral",
  SUBSCRIPTION_IMPORTED: "neutral",
  SUBSCRIPTION_VARIANT_CHANGED: "info",
  ORGANIZATION_CREATED: "info",
};

const ACTOR_LABEL = { USER: "You / team", SYSTEM: "System", INTEGRATION: "Integration" } as const;

export function ActivityItem({ item, timeZone, last }: { item: ActivityLog; timeZone: string; last?: boolean }) {
  const tone = TONES[item.eventType] ?? "neutral";
  return (
    <TimelineItem
      tone={tone}
      last={last}
      title={item.summary}
      description={
        <span>
          {ACTOR_LABEL[item.actorType]} · <span className="font-mono text-[11px]">{item.eventType.toLowerCase().replace(/_/g, " ")}</span>
        </span>
      }
      time={<span title={formatDateTime(item.createdAt, timeZone)}>{formatRelative(item.createdAt)}</span>}
    />
  );
}

export function activityTone(eventType: string): Tone {
  return TONES[eventType] ?? "neutral";
}

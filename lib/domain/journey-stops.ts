import type { JourneyStop } from "@/components/domain/journey-strip";
import { ordinal } from "@/lib/format";

type MilestoneLike = {
  cycleNumber: number;
  executionMode: string;
  rewardItem: { name: string };
};

/**
 * Turns a programme's milestone schedule plus one customer's progress into the stops of a
 * journey strip. Deliveries up to `done` are complete; `targetCycle` is the delivery the
 * automation is working towards. When the schedule has no milestone for the first delivery
 * but the customer has already had one, a plain first stop is synthesised so the strip
 * starts where the customer started.
 */
export function buildJourneyStops(
  milestones: MilestoneLike[],
  done: number,
  targetCycle: number | null,
  opts?: { addedAtTarget?: boolean },
): JourneyStop[] {
  const stops: JourneyStop[] = milestones
    .slice()
    .sort((x, y) => x.cycleNumber - y.cycleNumber)
    .map((m) => ({
      label: `${ordinal(m.cycleNumber)} delivery`,
      sub:
        m.cycleNumber === targetCycle
          ? `${m.rewardItem.name}${opts?.addedAtTarget ? " added" : ""}`
          : m.executionMode === "INITIAL_CHECKOUT"
            ? `${m.rewardItem.name} at checkout`
            : m.rewardItem.name,
      state: m.cycleNumber <= done ? "done" : m.cycleNumber === targetCycle ? "next" : "future",
    }));
  if (stops.length > 0 && done >= 1 && stops[0].state !== "done" && milestones.every((m) => m.cycleNumber !== 1)) {
    stops.unshift({ label: "1st delivery", sub: null, state: "done" });
  }
  return stops;
}

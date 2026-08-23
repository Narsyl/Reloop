/**
 * D6 scheduling maths (pure, no I/O).
 *
 *   targetChargeDate  = the subscription's exact provider date-only value ("YYYY-MM-DD")
 *   targetChargeAt    = local midnight of that date in the ORGANISATION's timezone — the earliest
 *                       instant the provider could run the charge
 *   executeAfter      = targetChargeAt − markerLeadHours; if that is already in the past at planning
 *                       time (we are inside the window) → now
 *
 * No hard-coded UTC hour anywhere: the timezone comes from the organisation.
 */
import { localMidnightUtc } from "@/lib/domain/time";

export type Schedule = {
  targetChargeDate: string;
  targetChargeAt: Date;
  executeAfter: Date;
  /** true when planning happened inside the lead window (executeAfter was clamped to now) */
  insideWindow: boolean;
};

export function computeSchedule(input: { targetChargeDate: string; timezone: string; markerLeadHours: number; now: Date }): Schedule {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.targetChargeDate)) throw new Error(`targetChargeDate must be YYYY-MM-DD, got "${input.targetChargeDate}"`);
  const targetChargeAt = localMidnightUtc(input.targetChargeDate, input.timezone);
  const ideal = new Date(targetChargeAt.getTime() - input.markerLeadHours * 3_600_000);
  const insideWindow = ideal.getTime() < input.now.getTime();
  return { targetChargeDate: input.targetChargeDate, targetChargeAt, executeAfter: insideWindow ? new Date(input.now) : ideal, insideWindow };
}

/** Has the scheduled target already been reached (charge day started in the org timezone)? */
export function targetHasPassed(targetChargeAt: Date, now: Date): boolean {
  return targetChargeAt.getTime() <= now.getTime();
}

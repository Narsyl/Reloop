/**
 * Pure date helpers shared by sync (nextChargeAt) and action scheduling (D6).
 * No I/O, no server-only — safe for unit tests and pure modules.
 */

/** Local midnight of a YYYY-MM-DD in `timeZone` — the earliest instant the charge could run. */
export function localMidnightUtc(ymd: string, timeZone: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  // find the UTC instant at which local time is 00:00 on that date
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const localAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"));
  const offset = localAsUtc - guess; // how far local is ahead of UTC at that instant
  return new Date(guess - offset);
}

/** YYYY-MM-DD of an instant in `timeZone`. */
export function dateOnlyInZone(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

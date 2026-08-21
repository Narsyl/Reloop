/**
 * Display formatting helpers. All date formatting is timezone-aware: pass the
 * organisation's timezone (OrgContext.timezone) so operators see merchant-local
 * dates, never the server's.
 */

export function formatDate(
  value: Date | string | null | undefined,
  timeZone: string,
  opts: Intl.DateTimeFormatOptions = {},
): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone,
    ...opts,
  }).format(d);
}

export function formatDateTime(value: Date | string | null | undefined, timeZone: string): string {
  return formatDate(value, timeZone, { hour: "2-digit", minute: "2-digit" });
}

/** "24 Sep" (no year) — for compact tables/timelines. */
export function formatShortDate(value: Date | string | null | undefined, timeZone: string): string {
  return formatDate(value, timeZone, { year: undefined });
}

/** Format a Recharge-style date-only string (YYYY-MM-DD) without timezone shifting. */
export function formatDateOnly(value: string | null | undefined, withYear = true): string {
  if (!value) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(d);
}

export function formatRelative(value: Date | string | null | undefined, now = new Date()): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  const diffMs = d.getTime() - now.getTime();
  const abs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });
  const minutes = Math.round(diffMs / 60_000);
  if (abs < 60_000) return "just now";
  if (abs < 3_600_000) return rtf.format(minutes, "minute");
  const hours = Math.round(diffMs / 3_600_000);
  if (abs < 86_400_000) return rtf.format(hours, "hour");
  const days = Math.round(diffMs / 86_400_000);
  if (abs < 30 * 86_400_000) return rtf.format(days, "day");
  const months = Math.round(days / 30);
  return rtf.format(months, "month");
}

export function formatMoney(
  amount: number | string | { toString(): string } | null | undefined,
  currency: string,
): string {
  if (amount === null || amount === undefined) return "—";
  const n = typeof amount === "number" ? amount : Number(amount.toString());
  if (Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(n);
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-GB").format(n);
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

export function customerName(c: { firstName?: string | null; lastName?: string | null; email?: string | null } | null | undefined): string {
  if (!c) return "Unknown customer";
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
  return name || c.email || "Unknown customer";
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

export function pluralize(n: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(n)} ${n === 1 ? singular : plural}`;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

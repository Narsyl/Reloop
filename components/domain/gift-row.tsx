import Link from "next/link";
import type { Route } from "next";
import { customerName, formatDateOnly, initials } from "@/lib/format";
import { giftSentence } from "@/lib/copy";
import { StatusBadge } from "@/components/status/status-badge";
import type { StatusMeta } from "@/lib/status";

export type GiftRowAction = {
  id: string;
  targetCycle: number;
  targetChargeDate: string | null;
  subscription: { customer: { firstName: string | null; lastName: string | null; email: string | null } | null };
  journey: { program: { name: string } };
  rewardItem: { name: string } | null;
  fulfillmentMarker: { name: string } | null;
};

/**
 * One queued gift as a list row: who, which gift, where it stands, when it renews.
 * Shared by the Upcoming queue and the Overview preview so the two always read the same.
 */
export function GiftRow({ action: a, state }: { action: GiftRowAction; state: StatusMeta }) {
  const name = customerName(a.subscription.customer);
  return (
    <Link
      href={`/upcoming/${a.id}` as Route}
      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
    >
      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-[11px] font-semibold text-muted-foreground">
        {initials(name)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="block truncate text-[13px] text-muted-foreground">{giftSentence(a)}</span>
      </span>
      <StatusBadge status={state} />
      <span className="tnum w-24 shrink-0 text-right text-[12.5px] text-muted-foreground">
        {a.targetChargeDate ? <>renews {formatDateOnly(a.targetChargeDate, false)}</> : "no date"}
      </span>
    </Link>
  );
}

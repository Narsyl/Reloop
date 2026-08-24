import Link from "next/link";
import type { Route } from "next";
import { customerName, formatDateOnly, initials, ordinal } from "@/lib/format";
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
 * One queued gift as a list row. In the default "customer" context the row leads with who is
 * receiving it (Upcoming, Overview). In the "gift" context, used where the page is already about
 * one customer, the row leads with the gift itself so the name is not repeated down the list.
 */
export function GiftRow({ action: a, state, context = "customer" }: { action: GiftRowAction; state: StatusMeta; context?: "customer" | "gift" }) {
  const name = customerName(a.subscription.customer);
  const reward = a.rewardItem?.name ?? a.fulfillmentMarker?.name ?? "Gift";
  const primary = context === "gift" ? reward : name;
  const secondary = context === "gift" ? `With the ${ordinal(a.targetCycle)} ${a.journey.program.name} delivery` : giftSentence(a);
  return (
    <Link
      href={`/upcoming/${a.id}` as Route}
      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
    >
      {context === "customer" ? (
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-[11px] font-semibold text-muted-foreground">
          {initials(name)}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{primary}</span>
        <span className="block truncate text-[13px] text-muted-foreground">{secondary}</span>
      </span>
      <StatusBadge status={state} />
      <span className="tnum w-24 shrink-0 text-right text-[12.5px] text-muted-foreground">
        {a.targetChargeDate ? <>renews {formatDateOnly(a.targetChargeDate, false)}</> : "no date"}
      </span>
    </Link>
  );
}

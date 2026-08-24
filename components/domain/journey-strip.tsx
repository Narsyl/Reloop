import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export type JourneyStop = {
  /** e.g. "1st delivery" */
  label: string;
  /** e.g. "Whisk at checkout", "Cup added", "28 Aug" */
  sub?: string | null;
  state: "done" | "next" | "future";
  /** The delivery number shown in the circle. Falls back to the stop's position. */
  num?: number;
};

/**
 * The reward journey as a strip of stops. Used on Rewards, Subscription detail and the Upcoming
 * detail view. Server component; horizontal scroll on small screens.
 */
export function JourneyStrip({ stops, className, trailing = false }: { stops: JourneyStop[]; className?: string; trailing?: boolean }) {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <div className="flex min-w-max items-start">
        {stops.map((s, i) => (
          <div key={i} className="flex items-start">
            {i > 0 && <div aria-hidden className={cn("mt-[15px] h-px w-7 sm:w-10", stops[i].state === "done" || (stops[i - 1].state === "done" && stops[i].state === "next") ? "bg-status-success/50" : "bg-border")} />}
            <div className="flex w-24 flex-col items-center gap-1.5 text-center">
              <span
                aria-hidden
                className={cn(
                  "flex size-8 items-center justify-center rounded-full border text-[13px] font-semibold",
                  s.state === "done" && "border-status-success bg-status-success text-white",
                  s.state === "next" && "border-primary bg-background text-primary ring-4 ring-primary/10",
                  s.state === "future" && "border-border bg-background text-muted-foreground",
                )}
              >
                {s.state === "done" ? <Check className="size-4" strokeWidth={3} /> : (s.num ?? i + 1)}
              </span>
              <span className={cn("text-[11.5px] leading-tight", s.state === "next" ? "font-semibold text-foreground" : "text-muted-foreground")}>
                {s.label}
                {s.sub ? <span className={cn("block", s.state === "next" ? "text-foreground/80" : "text-muted-foreground/80")}>{s.sub}</span> : null}
              </span>
            </div>
          </div>
        ))}
        {trailing && (
          <div className="flex items-start">
            <div aria-hidden className="mt-[15px] h-px w-7 bg-border sm:w-10" />
            <div className="flex w-16 flex-col items-center gap-1.5 pt-[9px] text-center">
              <span className="text-[13px] tracking-widest text-muted-foreground/70">···</span>
              <span className="text-[11.5px] text-muted-foreground/70">ongoing</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

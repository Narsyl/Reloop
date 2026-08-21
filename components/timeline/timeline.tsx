import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Tone } from "@/lib/status";
import { dotClasses } from "@/components/status/status-badge";

/**
 * Vertical timeline. Each item: a tone dot on a rail, a title line, optional
 * description and a right-aligned time. Used for Activity and journey history.
 */
export function Timeline({ children, className }: { children: ReactNode; className?: string }) {
  return <ol className={cn("relative space-y-0", className)}>{children}</ol>;
}

export function TimelineItem({
  tone = "neutral",
  title,
  description,
  time,
  icon,
  last = false,
  children,
}: {
  tone?: Tone;
  title: ReactNode;
  description?: ReactNode;
  time?: ReactNode;
  icon?: ReactNode;
  last?: boolean;
  children?: ReactNode;
}) {
  return (
    <li className="relative flex gap-3 pb-5 last:pb-0">
      {!last && <span aria-hidden className="absolute top-5 left-[7px] h-[calc(100%-0.5rem)] w-px bg-border" />}
      <div className="relative z-10 mt-1 flex size-[15px] shrink-0 items-center justify-center rounded-full bg-background ring-1 ring-border">
        {icon ?? <span className={cn("size-2 rounded-full", dotClasses[tone])} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0 text-sm text-foreground">{title}</div>
          {time && <div className="tnum shrink-0 text-xs text-muted-foreground">{time}</div>}
        </div>
        {description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
        {children}
      </div>
    </li>
  );
}

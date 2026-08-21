import { cn } from "@/lib/utils";
import type { StatusMeta, Tone } from "@/lib/status";

const toneClasses: Record<Tone, string> = {
  success: "bg-status-success-bg text-status-success",
  warning: "bg-status-warning-bg text-status-warning",
  danger: "bg-status-danger-bg text-status-danger",
  info: "bg-status-info-bg text-status-info",
  neutral: "bg-status-neutral-bg text-status-neutral",
};

const dotClasses: Record<Tone, string> = {
  success: "bg-status-success",
  warning: "bg-status-warning",
  danger: "bg-status-danger",
  info: "bg-status-info",
  neutral: "bg-status-neutral",
};

export function StatusBadge({
  status,
  className,
  dot = true,
  size = "sm",
}: {
  status: StatusMeta;
  className?: string;
  dot?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <span
      title={status.description}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md font-medium whitespace-nowrap",
        size === "sm" ? "h-5 px-1.5 text-[11px]" : "h-6 px-2 text-xs",
        toneClasses[status.tone],
        className,
      )}
    >
      {dot && <span aria-hidden className={cn("size-1.5 rounded-full", dotClasses[status.tone])} />}
      {status.label}
    </span>
  );
}

/** A small coloured dot only — for dense rows and timelines. */
export function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 rounded-full", dotClasses[tone], className)} />;
}

export { toneClasses, dotClasses };

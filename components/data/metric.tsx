import type { ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * A single headline number. Deliberately plain: label, value, one line of
 * context. No sparkline theatre unless the number has a meaningful trend.
 */
export function Metric({
  label,
  value,
  hint,
  href,
  tone,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  href?: string;
  tone?: "default" | "danger" | "warning";
  className?: string;
}) {
  const body = (
    <div
      className={cn(
        "flex h-full flex-col justify-between gap-3 rounded-xl border border-border bg-card p-4 transition-colors",
        href && "hover:border-foreground/20",
        className,
      )}
    >
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="space-y-0.5">
        <div
          className={cn(
            "tnum text-2xl font-semibold tracking-tight",
            tone === "danger" && "text-status-danger",
            tone === "warning" && "text-status-warning",
          )}
        >
          {value}
        </div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
    </div>
  );
  return href ? (
    <Link href={href} className="block rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
      {body}
    </Link>
  ) : (
    body
  );
}

export function MetricGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid gap-3 sm:grid-cols-2 xl:grid-cols-4", className)}>{children}</div>;
}

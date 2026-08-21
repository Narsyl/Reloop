import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Label / value pairs for detail pages. Use `mono` for ids and SKUs. */
export function DetailList({ children, className, columns = 1 }: { children: ReactNode; className?: string; columns?: 1 | 2 | 3 }) {
  return (
    <dl
      className={cn(
        "grid gap-x-8 gap-y-3",
        columns === 2 && "sm:grid-cols-2",
        columns === 3 && "sm:grid-cols-2 lg:grid-cols-3",
        className,
      )}
    >
      {children}
    </dl>
  );
}

export function DetailRow({
  label,
  children,
  mono = false,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 space-y-0.5", className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("truncate text-sm text-foreground", mono && "font-mono text-[13px]")}>{children}</dd>
    </div>
  );
}

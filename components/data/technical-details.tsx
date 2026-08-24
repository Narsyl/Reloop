import { cn } from "@/lib/utils";

/**
 * The one place internal vocabulary is allowed. Collapsed by default; everything a screen used to
 * show about ids, keys, payloads and provider objects lives inside one of these. Server component,
 * native disclosure, no JavaScript required.
 */
export function TechnicalDetails({ children, className, label = "Technical details", open = false }: { children: React.ReactNode; className?: string; label?: string; open?: boolean }) {
  return (
    <details open={open} className={cn("group rounded-xl border border-border bg-muted/40", className)}>
      <summary className="flex cursor-pointer items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-medium text-muted-foreground select-none outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="inline-block text-muted-foreground/70 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none">
          ›
        </span>
        {label}
      </summary>
      <div className="px-4 pt-1 pb-4 text-[13px] text-muted-foreground">{children}</div>
    </details>
  );
}

/** A labelled monospace fact inside TechnicalDetails. */
export function TechRow({ label, children, mono = true }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-border/60 py-1.5 last:border-0">
      <span className="w-44 shrink-0 text-[12px] text-muted-foreground/80">{label}</span>
      <span className={cn("min-w-0 break-all", mono && "font-mono text-[12px]")}>{children}</span>
    </div>
  );
}

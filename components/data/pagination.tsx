import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format";

/** URL-driven pagination: keeps every other search param, swaps `page`. */
export function Pagination({
  page,
  pages,
  total,
  pageSize,
  basePath,
  params,
  className,
}: {
  page: number;
  pages: number;
  total: number;
  pageSize: number;
  basePath: string;
  params: Record<string, string | undefined>;
  className?: string;
}) {
  const href = (p: number) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
    if (p > 1) sp.set("page", String(p));
    else sp.delete("page");
    const qs = sp.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const linkCls = "inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium hover:bg-muted aria-disabled:pointer-events-none aria-disabled:opacity-40";
  return (
    <div className={cn("flex items-center justify-between gap-4 text-xs text-muted-foreground", className)}>
      <div className="tnum">
        {total === 0 ? "No results" : `Showing ${formatNumber(from)}–${formatNumber(to)} of ${formatNumber(total)}`}
      </div>
      <div className="flex items-center gap-1">
        <Link href={href(page - 1)} aria-disabled={page <= 1} className={linkCls}>
          <ChevronLeft className="size-3.5" /> Prev
        </Link>
        <span className="tnum px-2">
          {page} / {pages}
        </span>
        <Link href={href(page + 1)} aria-disabled={page >= pages} className={linkCls}>
          Next <ChevronRight className="size-3.5" />
        </Link>
      </div>
    </div>
  );
}

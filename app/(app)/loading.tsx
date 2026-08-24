import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading">
      <div className="space-y-2 border-b border-border pb-5">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="overflow-hidden rounded-xl border border-border">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-0">
            <Skeleton className="size-8 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3 w-64 max-w-full" />
            </div>
            <Skeleton className="h-5 w-16" />
          </div>
        ))}
      </div>
      <Skeleton className="h-40 rounded-xl" />
    </div>
  );
}

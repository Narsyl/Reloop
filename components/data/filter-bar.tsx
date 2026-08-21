"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useRef, useState, useTransition, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * URL-synced filters. Every control writes to search params (so views are
 * shareable and the server does the filtering); `page` resets on any change.
 */
export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-center gap-2", className)}>{children}</div>;
}

export function useFilterNav() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();
  function set(updates: Record<string, string | null | undefined>) {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v === null || v === undefined || v === "" || v === "ALL") next.delete(k);
      else next.set(k, v);
    }
    next.delete("page");
    const qs = next.toString();
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname));
  }
  return { sp, set, pending };
}

export function SearchFilter({ name = "q", placeholder = "Search…", className }: { name?: string; placeholder?: string; className?: string }) {
  const { sp, set } = useFilterNav();
  const urlValue = sp.get(name) ?? "";
  const [prevUrlValue, setPrevUrlValue] = useState(urlValue);
  const [value, setValue] = useState(urlValue);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Re-sync local input when the URL changes externally (back/forward, Clear filters).
  if (urlValue !== prevUrlValue) {
    setPrevUrlValue(urlValue);
    setValue(urlValue);
  }
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        placeholder={placeholder}
        className="w-64 pl-8 pr-7"
        onChange={(e) => {
          const v = e.target.value;
          setValue(v);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => set({ [name]: v }), 300);
        }}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
          onClick={() => {
            setValue("");
            set({ [name]: null });
          }}
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function SelectFilter({
  name,
  label,
  options,
  allLabel = "All",
}: {
  name: string;
  label: string;
  options: { value: string; label: string }[];
  allLabel?: string;
}) {
  const { sp, set } = useFilterNav();
  const current = sp.get(name) ?? "ALL";
  return (
    <label className="flex h-8 items-center gap-1.5 rounded-lg border border-input bg-transparent pl-2.5 pr-1 text-sm">
      <span className="text-xs text-muted-foreground">{label}</span>
      <select
        value={current}
        onChange={(e) => set({ [name]: e.target.value })}
        className="h-full bg-transparent pr-1 text-sm outline-none"
      >
        <option value="ALL">{allLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ClearFilters() {
  const { sp, set } = useFilterNav();
  const keys = [...sp.keys()].filter((k) => k !== "page");
  if (keys.length === 0) return null;
  return (
    <button
      type="button"
      onClick={() => set(Object.fromEntries(keys.map((k) => [k, null])))}
      className="h-8 rounded-lg px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      Clear filters
    </button>
  );
}

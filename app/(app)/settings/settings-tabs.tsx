"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/settings/integrations", label: "Connections" },
  { href: "/settings/products", label: "Programmes and products" },
  { href: "/settings/team", label: "Team" },
  { href: "/settings/general", label: "Workspace" },
];

export function SettingsTabs() {
  const pathname = usePathname();
  return (
    <nav className="-mt-4 flex gap-1 border-b border-border" aria-label="Settings sections">
      {TABS.map((t) => {
        const active = pathname === t.href || pathname.startsWith(t.href + "/");
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

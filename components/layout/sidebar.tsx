"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  Boxes,
  CalendarClock,
  LayoutDashboard,
  Repeat,
  Settings,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type NavCounts = { openExceptions?: number };

type Item = { href: string; label: string; icon: LucideIcon; badge?: number; exact?: boolean };

export function SidebarNav({ counts = {} }: { counts?: NavCounts }) {
  const pathname = usePathname();

  const primary: Item[] = [
    { href: "/", label: "Overview", icon: LayoutDashboard, exact: true },
    { href: "/subscriptions", label: "Subscriptions", icon: Repeat },
    { href: "/upcoming", label: "Upcoming", icon: CalendarClock },
    { href: "/rules", label: "Rules", icon: SlidersHorizontal },
    { href: "/products", label: "Products", icon: Boxes },
  ];
  const secondary: Item[] = [
    { href: "/activity", label: "Activity", icon: Activity },
    { href: "/exceptions", label: "Exceptions", icon: AlertTriangle, badge: counts.openExceptions },
  ];

  const isActive = (item: Item) =>
    item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(item.href + "/");

  const render = (item: Item) => {
    const active = isActive(item);
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "group flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground/80 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground",
        )}
      >
        <item.icon className={cn("size-4 shrink-0", active ? "text-foreground" : "text-muted-foreground group-hover:text-foreground")} />
        <span className="flex-1 truncate">{item.label}</span>
        {item.badge ? (
          <span className="tnum rounded-md bg-status-danger-bg px-1.5 py-px text-[11px] font-semibold text-status-danger">
            {item.badge}
          </span>
        ) : null}
      </Link>
    );
  };

  return (
    <nav className="flex flex-1 flex-col gap-5 px-2" aria-label="Main">
      <div className="flex flex-col gap-0.5">{primary.map(render)}</div>
      <div className="flex flex-col gap-0.5">{secondary.map(render)}</div>
    </nav>
  );
}

export function SidebarSettingsLink() {
  const pathname = usePathname();
  const active = pathname.startsWith("/settings");
  return (
    <Link
      href="/settings/general"
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/80 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground",
      )}
    >
      <Settings className="size-4 text-muted-foreground" />
      Settings
    </Link>
  );
}

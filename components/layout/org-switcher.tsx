"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { switchOrganization } from "@/lib/domain/organizations/actions";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

export type OrgOption = { id: string; name: string; slug: string; role: string };

export function OrgSwitcher({ current, options }: { current: OrgOption; options: OrgOption[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function choose(id: string) {
    if (id === current.id) return;
    startTransition(async () => {
      const res = await switchOrganization(id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      router.push("/overview");
      router.refresh();
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-sidebar-accent",
          pending && "opacity-60",
        )}
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-[11px] font-semibold text-sidebar-primary-foreground">
          {initials(current.name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-sidebar-foreground">{current.name}</span>
          <span className="block truncate text-[11px] text-muted-foreground capitalize">{current.role.toLowerCase()}</span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" sideOffset={6} className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Organisations</DropdownMenuLabel>
          {options.map((o) => (
            <DropdownMenuItem key={o.id} onClick={() => choose(o.id)} className="gap-2">
              <span className="flex size-5 items-center justify-center rounded bg-muted text-[10px] font-semibold">
                {initials(o.name)}
              </span>
              <span className="flex-1 truncate">{o.name}</span>
              {o.id === current.id && <Check className="size-4 text-muted-foreground" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push("/onboarding?new=1")} className="gap-2">
          <Plus className="size-4" />
          New organisation
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

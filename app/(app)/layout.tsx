import Link from "next/link";
import { requireOrg, listMemberships } from "@/lib/auth/tenancy";
import { requireUser } from "@/lib/auth/session";
import { getNavCounts } from "@/lib/domain/queries/overview";
import { SidebarNav, SidebarSettingsLink } from "@/components/layout/sidebar";
import { OrgSwitcher } from "@/components/layout/org-switcher";
import { UserMenu } from "@/components/layout/user-menu";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const [session, ctx] = await Promise.all([requireUser(), requireOrg()]);
  const [memberships, counts] = await Promise.all([listMemberships(), getNavCounts(ctx)]);
  const options = memberships.map((m) => ({
    id: m.organization.id,
    name: m.organization.name,
    slug: m.organization.slug,
    role: m.role,
  }));
  const current = options.find((o) => o.id === ctx.organizationId) ?? {
    id: ctx.organizationId,
    name: ctx.organizationName,
    slug: ctx.organizationSlug,
    role: ctx.role,
  };

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <div className="flex h-14 items-center px-4">
          <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight text-sidebar-foreground">
            <span className="flex size-6 items-center justify-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">S</span>
            Subscription Ops
          </Link>
        </div>
        <div className="flex flex-1 flex-col overflow-y-auto py-2">
          <SidebarNav counts={counts} />
        </div>
        <div className="flex flex-col gap-1 border-t border-sidebar-border p-2">
          <OrgSwitcher current={current} options={options} />
          <SidebarSettingsLink />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-4 border-b border-border bg-background/80 px-4 backdrop-blur md:px-8">
          <div className="flex items-center gap-3 md:hidden">
            <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
              <span className="flex size-6 items-center justify-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">S</span>
              {ctx.organizationName}
            </Link>
          </div>
          <div className="hidden text-sm text-muted-foreground md:block">{ctx.organizationName}</div>
          <UserMenu name={session.user.name} email={session.user.email} />
        </header>
        <main className="flex-1 px-4 py-6 md:px-8 md:py-8">
          <div className="mx-auto w-full max-w-6xl space-y-8">{children}</div>
        </main>
      </div>
    </div>
  );
}

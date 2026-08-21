import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";

export default async function AuthLayout({ children }: LayoutProps<"/">) {
  const session = await getSession();
  if (session) redirect("/");
  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <header className="flex h-14 items-center px-6">
        <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <span className="flex size-6 items-center justify-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">S</span>
          Subscription Ops
        </Link>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 py-12 sm:items-center sm:py-0">
        <div className="w-full max-w-sm">{children}</div>
      </main>
      <footer className="px-6 py-4 text-xs text-muted-foreground">Milestone fulfilment automation for subscription commerce.</footer>
    </div>
  );
}

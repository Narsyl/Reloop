import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";

export default async function AuthLayout({ children }: LayoutProps<"/">) {
  const session = await getSession();
  if (session) redirect("/");
  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <main className="flex flex-1 items-start justify-center px-4 pt-14 pb-10 sm:pt-24">
        <div className="w-full max-w-[460px]">{children}</div>
      </main>
      <footer className="px-6 py-5 text-center text-xs text-muted-foreground">Reloop adds reward gifts to subscription renewals.</footer>
    </div>
  );
}

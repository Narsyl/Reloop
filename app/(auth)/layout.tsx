import Link from "next/link";
import Image from "next/image";
import relooplogo from "@/app/relooplogo-trimmed.png";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";

export default async function AuthLayout({ children }: LayoutProps<"/">) {
  const session = await getSession();
  if (session) redirect("/");
  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <header className="flex h-14 items-center px-6">
        <Link href="/" className="flex items-center">
          <Image src={relooplogo} alt="Reloop" className="h-7 w-auto object-contain" priority />
        </Link>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 py-12 sm:items-center sm:py-0">
        <div className="w-full max-w-sm">{children}</div>
      </main>
      <footer className="px-6 py-4 text-xs text-muted-foreground">Reloop adds reward gifts to subscription renewals.</footer>
    </div>
  );
}

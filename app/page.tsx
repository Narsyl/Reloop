import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import relooplogo from "@/app/relooplogo-trimmed.png";
import { getSession } from "@/lib/auth/session";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Reloop" };

export default async function HomePage() {
  const session = await getSession();
  if (session) redirect("/overview");

  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <header className="flex h-16 items-center justify-between px-6 sm:px-10">
        <Image src={relooplogo} alt="Reloop" className="h-8 w-auto object-contain" priority />
        <Button variant="outline" size="sm" render={<Link href="/login" />}>
          Log in
        </Button>
      </header>
      <main className="flex flex-1 items-center justify-center px-6 pb-24">
        <div className="text-center">
          <h1 className="text-5xl font-semibold tracking-tight text-balance sm:text-6xl">Hello Jazz and Steve</h1>
          <p className="mx-auto mt-5 max-w-md text-lg text-muted-foreground">
            Welcome to Reloop. It adds reward gifts to subscription renewals, automatically.
          </p>
          <div className="mt-9">
            <Button size="lg" render={<Link href="/login" />}>
              Log in
            </Button>
          </div>
        </div>
      </main>
      <footer className="px-6 py-5 text-center text-xs text-muted-foreground">Reloop</footer>
    </div>
  );
}

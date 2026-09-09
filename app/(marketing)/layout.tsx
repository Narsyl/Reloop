import Link from "next/link";
import Image from "next/image";
import relooplogo from "@/app/relooplogo-trimmed.png";
import { Button } from "@/components/ui/button";

export default function MarketingLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-6 px-6">
          <Link href="/" className="flex shrink-0 items-center">
            <Image src={relooplogo} alt="Reloop" className="h-7 w-auto object-contain" priority />
          </Link>
          <nav className="flex items-center gap-1 sm:gap-2" aria-label="Site">
            <Link href="/how-it-works" className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              How it works
            </Link>
            <Link href="/blog" className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              Blog
            </Link>
            <Button variant="outline" size="sm" className="ml-2" render={<Link href="/login" />}>
              Log in
            </Button>
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <Image src={relooplogo} alt="Reloop" className="h-6 w-auto object-contain" />
            <span className="text-sm text-muted-foreground">Reward gifts for subscription renewals.</span>
          </div>
          <nav className="flex items-center gap-5 text-sm text-muted-foreground" aria-label="Footer">
            <Link href="/how-it-works" className="hover:text-foreground">How it works</Link>
            <Link href="/blog" className="hover:text-foreground">Blog</Link>
            <Link href="/login" className="hover:text-foreground">Log in</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

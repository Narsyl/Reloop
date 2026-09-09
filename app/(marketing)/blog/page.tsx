import Link from "next/link";
import type { Route } from "next";
import { posts } from "@/lib/marketing/posts";

export const metadata = {
  title: "Blog",
  description: "Notes from Reloop on milestone gifting, subscription retention and building software careful enough to touch real orders.",
};

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" });

export default function BlogIndexPage() {
  const sorted = [...posts].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-16 lg:py-24">
      <p className="mb-4 text-[13px] font-semibold tracking-wide text-primary uppercase">Blog</p>
      <h1 className="text-4xl font-semibold tracking-tight text-balance">Notes on gifting the customers who stay</h1>
      <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted-foreground">
        Short pieces on milestone rewards, subscription retention, and what it takes to build software careful enough to touch real orders.
      </p>
      <ul className="mt-14 space-y-12">
        {sorted.map((p) => (
          <li key={p.slug} className="group">
            <article>
              <p className="tnum text-xs text-muted-foreground">
                {dateFmt.format(new Date(p.date))} · {p.readMinutes} minute read
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-balance">
                <Link href={`/blog/${p.slug}` as Route} className="group-hover:underline">
                  {p.title}
                </Link>
              </h2>
              <p className="mt-2.5 max-w-2xl leading-relaxed text-muted-foreground">{p.description}</p>
              <Link href={`/blog/${p.slug}` as Route} className="mt-3 inline-block text-sm font-medium text-primary hover:underline">
                Read the piece
              </Link>
            </article>
          </li>
        ))}
      </ul>
    </div>
  );
}

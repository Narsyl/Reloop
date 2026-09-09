import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { getPost, posts } from "@/lib/marketing/posts";
import { Button } from "@/components/ui/button";

export function generateStaticParams() {
  return posts.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: PageProps<"/blog/[slug]">) {
  const { slug } = await params;
  const post = getPost(slug);
  return post ? { title: post.title, description: post.description } : {};
}

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" });

export default async function BlogPostPage({ params }: PageProps<"/blog/[slug]">) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();

  return (
    <article className="mx-auto w-full max-w-3xl px-6 py-16 lg:py-24">
      <p className="text-[13px] font-medium">
        <Link href="/blog" className="text-muted-foreground hover:text-foreground">Blog</Link>
      </p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight text-balance">{post.title}</h1>
      <p className="tnum mt-4 text-sm text-muted-foreground">
        {dateFmt.format(new Date(post.date))} · {post.readMinutes} minute read · The Reloop team
      </p>
      <div className="mt-10 space-y-8">
        {post.sections.map((s, i) => (
          <section key={i} className="space-y-4">
            {s.heading ? <h2 className="text-xl font-semibold tracking-tight">{s.heading}</h2> : null}
            {s.paragraphs.map((p, j) => (
              <p key={j} className="text-[17px] leading-[1.75] text-foreground/85">
                {p}
              </p>
            ))}
          </section>
        ))}
      </div>
      <footer className="mt-14 border-t border-border pt-8">
        <p className="text-sm text-muted-foreground">Reloop adds reward gifts to subscription renewals for Recharge brands.</p>
        <div className="mt-4 flex gap-3">
          <Button render={<Link href="/signup" />}>
            Get started <ArrowRight data-icon="inline-end" />
          </Button>
          <Button variant="outline" render={<Link href="/how-it-works" />}>
            How it works
          </Button>
        </div>
      </footer>
    </article>
  );
}

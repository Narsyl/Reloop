import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { Button } from "@/components/ui/button";
import { JourneyStrip } from "@/components/domain/journey-strip";
import { StatusBadge } from "@/components/status/status-badge";

export const metadata = {
  title: "Reloop",
  description: "Reloop adds a free gift to a customer's renewal when they reach the delivery milestones you choose. Built for Recharge subscription brands.",
};

const QUEUE_ROWS = [
  { initials: "FW", name: "Freya Wilmot", line: "Whisk with the 2nd Matcha delivery", state: { label: "Verified", tone: "success" as const }, renews: "renews 14 Sep" },
  { initials: "AO", name: "Arthur Okafor", line: "Cup with the 3rd Cacao delivery", state: { label: "Added", tone: "success" as const }, renews: "renews 16 Sep" },
  { initials: "MB", name: "Mabel Brennan", line: "Spoon with the 5th Reishi delivery", state: { label: "Scheduled", tone: "neutral" as const }, renews: "renews 29 Sep" },
];

export default async function LandingPage() {
  const session = await getSession();
  if (session) redirect("/overview");

  return (
    <>
      {/* hero */}
      <section className="border-b border-border bg-surface">
        <div className="mx-auto grid w-full max-w-6xl gap-12 px-6 py-20 lg:grid-cols-[1.1fr_1fr] lg:items-center lg:py-28">
          <div>
            <p className="mb-4 text-[13px] font-semibold tracking-wide text-primary uppercase">For Recharge subscription brands</p>
            <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-[3.4rem] lg:leading-[1.08]">
              The 3rd delivery deserves a gift.
            </h1>
            <p className="mt-6 max-w-lg text-lg leading-relaxed text-muted-foreground">
              Reloop watches every subscription and slips a free gift into the renewal box at the delivery milestones you choose. The customers who stay get rewarded for staying, automatically, inside the parcel they were already getting.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Button size="lg" render={<Link href="/signup" />}>
                Get started <ArrowRight data-icon="inline-end" />
              </Button>
              <Button size="lg" variant="outline" render={<Link href="/how-it-works" />}>
                See how it works
              </Button>
            </div>
            <p className="mt-5 text-sm text-muted-foreground">Connects to Recharge in minutes. Reads everything, writes nothing until you say so.</p>
          </div>

          {/* the product, as it actually looks */}
          <div className="min-w-0">
            <div className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_15px_35px_rgba(60,66,87,0.08),0_5px_15px_rgba(0,0,0,0.08)]">
              <header className="flex items-center justify-between border-b border-border px-4 py-2">
                <h2 className="text-[11.5px] font-semibold tracking-wide text-muted-foreground uppercase">This week</h2>
                <span className="tnum text-[11.5px] text-muted-foreground">3</span>
              </header>
              <ul>
                {QUEUE_ROWS.map((r) => (
                  <li key={r.name} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-0">
                    <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-[11px] font-semibold text-muted-foreground">
                      {r.initials}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{r.name}</span>
                      <span className="block truncate text-[13px] text-muted-foreground">{r.line}</span>
                    </span>
                    <StatusBadge status={r.state} />
                    <span className="tnum hidden w-24 shrink-0 text-right text-[12.5px] text-muted-foreground sm:block">{r.renews}</span>
                  </li>
                ))}
              </ul>
            </div>
            <p className="mt-3 text-center text-xs text-muted-foreground">The Reloop queue: who gets what, with which delivery, and where it stands.</p>
          </div>
        </div>
      </section>

      {/* the journey */}
      <section className="mx-auto w-full max-w-6xl px-6 py-20 lg:py-24">
        <div className="max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-tight text-balance">Design the journey once. Reloop runs it for every customer.</h2>
          <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
            Decide which delivery brings which gift. A whisk with the second box, a proper cup with the third, a spoon when they reach five. Reloop counts every successful delivery per customer per product line and keeps each journey on track through date changes, product swaps and cancellations.
          </p>
        </div>
        <div className="mt-10 rounded-xl border border-border bg-card p-6 sm:p-8">
          <JourneyStrip
            stops={[
              { num: 1, label: "1st delivery", sub: null, state: "done" },
              { num: 2, label: "2nd delivery", sub: "Whisk added", state: "done" },
              { num: 3, label: "3rd delivery", sub: "Cup", state: "next" },
              { num: 5, label: "5th delivery", sub: "Spoon", state: "future" },
            ]}
            trailing
          />
        </div>
      </section>

      {/* how it works, condensed */}
      <section className="border-y border-border bg-surface">
        <div className="mx-auto w-full max-w-6xl px-6 py-20 lg:py-24">
          <h2 className="text-3xl font-semibold tracking-tight">Four steps, then it runs itself</h2>
          <ol className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { n: 1, t: "Connect Recharge", d: "One API token. Reloop imports your subscriptions, customers and order history, and only ever reads." },
              { n: 2, t: "Choose the gifts", d: "Pick real products from your store as gifts and group your subscription products into programmes." },
              { n: 3, t: "Rehearse in test mode", d: "Reloop plans every gift and checks it against live data, showing you exactly what it would do. Nothing is written." },
              { n: 4, t: "Go live", d: "Due gifts are added to renewals automatically, each one checked before and verified after. You watch the queue." },
            ].map((s) => (
              <li key={s.n}>
                <span aria-hidden className="tnum flex size-8 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-[13px] font-semibold text-primary">
                  {s.n}
                </span>
                <h3 className="mt-4 text-base font-semibold">{s.t}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.d}</p>
              </li>
            ))}
          </ol>
          <div className="mt-10">
            <Link href="/how-it-works" className="text-sm font-medium text-primary hover:underline">
              Read the full walkthrough
            </Link>
          </div>
        </div>
      </section>

      {/* safety */}
      <section className="mx-auto w-full max-w-6xl px-6 py-20 lg:py-24">
        <div className="grid gap-12 lg:grid-cols-2">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight text-balance">Careful enough to trust with real orders</h2>
            <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
              Reloop writes to your store the way you would want a colleague to: rarely, precisely, and with proof. Prices are never touched. Products are never created. The gift is an extra line at a price of zero on the renewal the customer already has.
            </p>
            <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
              Anything that cannot pass its checks stays queued with a plain explanation. Anything unexpected stops and asks. Every decision is on the record.
            </p>
          </div>
          <ul className="space-y-5">
            {[
              { t: "Fresh check before every write", d: "The subscription, the renewal date, the gift product and the absence of duplicates are confirmed against live data moments before anything happens." },
              { t: "Pinned to the exact renewal date", d: "A gift belongs to one specific renewal. If the date moves, the gift is held and rescheduled rather than landing on the wrong order." },
              { t: "One write, verified after", d: "Reloop writes exactly once, then reads the result back and compares every field. A gift only counts once the readback matches." },
              { t: "Test mode whenever you want it", d: "Switch back to rehearsals at any time. The queue keeps planning and checking, and nothing is written." },
            ].map((f) => (
              <li key={f.t} className="rounded-xl border border-border bg-card p-5">
                <h3 className="text-sm font-semibold">{f.t}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{f.d}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* freshness */}
      <section className="border-t border-border bg-surface">
        <div className="mx-auto w-full max-w-6xl px-6 py-20 lg:py-24">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-semibold tracking-tight">Always working from this morning&rsquo;s truth</h2>
            <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
              Webhooks bring every new order, renewal and cancellation into Reloop the moment it happens, and a full sweep runs every twenty minutes as the backstop. Journeys recount themselves, the queue replans itself, and the numbers you see on the overview are the numbers in your store.
            </p>
          </div>
        </div>
      </section>

      {/* cta */}
      <section className="mx-auto w-full max-w-6xl px-6 py-20 text-center lg:py-28">
        <h2 className="mx-auto max-w-xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">Give your best customers a reason to stay that is not a discount.</h2>
        <div className="mt-8 flex justify-center gap-3">
          <Button size="lg" render={<Link href="/signup" />}>
            Get started <ArrowRight data-icon="inline-end" />
          </Button>
          <Button size="lg" variant="outline" render={<Link href="/how-it-works" />}>
            How it works
          </Button>
        </div>
      </section>
    </>
  );
}

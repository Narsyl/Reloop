import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { JourneyStrip } from "@/components/domain/journey-strip";

export const metadata = {
  title: "How it works",
  description: "How Reloop counts deliveries, plans reward gifts and places them on Recharge renewals, from connection to going live.",
};

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-6 border-t border-border py-12 lg:grid-cols-[220px_1fr] lg:gap-12">
      <div className="flex items-start gap-4 lg:block">
        <span aria-hidden className="tnum flex size-9 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-sm font-semibold text-primary">
          {n}
        </span>
        <h2 className="text-xl font-semibold tracking-tight lg:mt-4">{title}</h2>
      </div>
      <div className="space-y-4 text-[15px] leading-relaxed text-muted-foreground [&_strong]:font-semibold [&_strong]:text-foreground">{children}</div>
    </section>
  );
}

export default function HowItWorksPage() {
  return (
    <>
      <section className="mx-auto w-full max-w-4xl px-6 pt-16 pb-4 lg:pt-24">
        <p className="mb-4 text-[13px] font-semibold tracking-wide text-primary uppercase">How it works</p>
        <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">From connected to gifting, in five honest steps</h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">
          Reloop is deliberately boring underneath: it counts deliveries, plans gifts, checks everything twice and writes once. Here is the whole journey from a fresh account to gifts shipping inside renewal boxes, including exactly what Reloop reads and writes at each stage.
        </p>
      </section>

      <div className="mx-auto w-full max-w-4xl px-6 pb-8">
        <Step n={1} title="Connect Recharge">
          <p>
            Create an API token in Recharge and paste it into Reloop. The token needs to view customers, products, orders and store information, and to view and manage subscriptions. No premium Recharge features are required.
          </p>
          <p>
            Reloop tests the token, probes exactly what it can access, and then imports your subscriptions, customers and full order history. <strong>The import only reads.</strong> From then on, webhooks deliver every new order and subscription change the moment it happens, and a sweep every twenty minutes catches anything they miss.
          </p>
          <p>
            If your gifts live in a Shopify catalogue, you also connect Shopify with a client ID and secret. That connection is read only by construction: Reloop can look products up and nothing else.
          </p>
        </Step>

        <Step n={2} title="Group products into programmes">
          <p>
            A programme groups the products that share one customer journey. Morning Magic in every size is one programme, so a customer who switches sizes keeps their delivery count. A completely different product line is a different programme with its own journey.
          </p>
          <p>
            Reloop then counts <strong>successful deliveries</strong> per customer within each programme. Not orders placed, not charges attempted: orders that actually processed. A failed payment does not advance anyone&rsquo;s journey, and a swap to a different programme starts a fresh count.
          </p>
        </Step>

        <Step n={3} title="Design the reward journey">
          <p>
            A journey is a short list of milestones: which delivery brings which gift. You create it once and any number of programmes can share it.
          </p>
          <div className="rounded-xl border border-border bg-card p-5 sm:p-6">
            <JourneyStrip
              stops={[
                { num: 2, label: "2nd delivery", sub: "Whisk", state: "future" },
                { num: 3, label: "3rd delivery", sub: "Cup", state: "future" },
                { num: 5, label: "5th delivery", sub: "Spoon", state: "future" },
              ]}
              trailing
            />
          </div>
          <p>
            Each gift is linked to a <strong>real product in your store</strong>. You search your catalogue from inside Reloop, pick the exact product, and Reloop stores the reference and verifies it stays valid. Nothing is created or edited in your catalogue, and retail prices are never touched: the gift ships as an extra line at a price of zero.
          </p>
        </Step>

        <Step n={4} title="Watch it rehearse in test mode">
          <p>
            With the journey ready, Reloop plans a gift for every customer approaching a milestone and shows the whole queue on the Upcoming page: who is receiving what, with which delivery, and when it renews.
          </p>
          <p>
            In test mode every planned gift is <strong>rehearsed against live data</strong> on a rolling schedule: is the subscription still active, does the renewal date still match, does the gift product still verify, would the write succeed. You can open any gift and read the exact preview of what would be written. Nothing is written.
          </p>
          <p>
            Stay in test mode as long as you like. Brands typically watch a week of rehearsals pass their checks before switching on.
          </p>
        </Step>

        <Step n={5} title="Go live">
          <p>
            Going live changes one thing: due gifts execute. Everything else stays exactly as strict. Immediately before each write, the full rehearsal runs again against live data. Only gifts whose product links are verified are eligible. Reloop writes <strong>exactly once</strong>, pinned to the exact renewal date, then reads the result back from Recharge and compares every field before counting the gift as added.
          </p>
          <p>
            When the renewal charges, the order that reaches your store and your fulfilment contains the subscription products plus the gift at a price of zero. The warehouse packs the order as printed. The customer opens the box and finds the gift.
          </p>
          <p>
            Anything that cannot pass its checks stays queued with a plain sentence explaining why. Anything genuinely unexpected stops, is held, and appears in your attention list with what happened and what to do. Every action, check and decision is kept on the record.
          </p>
        </Step>
      </div>

      <section className="border-t border-border bg-surface">
        <div className="mx-auto w-full max-w-4xl px-6 py-16">
          <h2 className="text-2xl font-semibold tracking-tight">Questions people ask</h2>
          <dl className="mt-8 space-y-7">
            {[
              { q: "What does Reloop actually write to my store?", a: "One thing only: a free gift line on a customer's upcoming renewal, at a price of zero, pinned to that renewal's exact date. It never edits products, prices, customers or existing orders, and its Shopify access cannot write at all." },
              { q: "What happens if a customer moves their renewal date?", a: "The gift is pinned to the original date, so it no longer matches and is held. Reloop reschedules it against the new date once the change is confirmed. Gifts never land on the wrong order." },
              { q: "What if a customer cancels before their milestone?", a: "The planned gift is cancelled with the reason recorded. If they resubscribe later, the journey rules you chose decide whether their count continues or starts fresh." },
              { q: "Does a delivery count if the payment failed?", a: "No. Journeys count successfully processed orders only, so a customer reaches a milestone by receiving boxes, not by being charged for them." },
              { q: "Can I try it without risking anything?", a: "Yes, that is the default. Test mode does everything except write: it imports, counts, plans and rehearses every gift against live data, and shows you the exact preview of each one. You switch to live when the rehearsals have earned it." },
            ].map((f) => (
              <div key={f.q}>
                <dt className="text-sm font-semibold">{f.q}</dt>
                <dd className="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted-foreground">{f.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="mx-auto w-full max-w-4xl px-6 py-16 text-center lg:py-20">
        <h2 className="text-2xl font-semibold tracking-tight text-balance">Ready to see your own queue?</h2>
        <div className="mt-6 flex justify-center gap-3">
          <Button size="lg" render={<Link href="/signup" />}>
            Get started <ArrowRight data-icon="inline-end" />
          </Button>
          <Button size="lg" variant="outline" render={<Link href="/blog" />}>
            Read the blog
          </Button>
        </div>
      </section>
    </>
  );
}

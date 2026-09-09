/**
 * Blog content for the marketing site. Plain structured prose, no CMS.
 * Copy rules apply: no emojis, no hyphens or dashes in visible text.
 */
export type Post = {
  slug: string;
  title: string;
  description: string;
  date: string;
  readMinutes: number;
  sections: { heading?: string; paragraphs: string[] }[];
};

export const posts: Post[] = [
  {
    slug: "why-delivery-milestones",
    title: "Why the 3rd delivery deserves a gift",
    description: "Discount codes reward the moment of doubt. Milestone gifts reward the habit you actually want to build.",
    date: "2026-09-02",
    readMinutes: 4,
    sections: [
      {
        paragraphs: [
          "Most subscription retention tactics fire at the wrong moment. A customer hovers over the cancel button, a winback email offers twenty percent off, and the brand teaches its best customers that wavering is how you get a better price.",
          "There is another moment available, and almost nobody uses it. The renewal that arrives on schedule. The customer who did not waver. The third box landing on a doorstep is proof that a habit is forming, and habits are the entire economics of subscription commerce.",
        ],
      },
      {
        heading: "A gift says something a discount cannot",
        paragraphs: [
          "A discount is an argument about price. A gift is a gesture about the relationship. When a matcha subscriber opens their second delivery and finds an electric whisk they never ordered, the message is simple: we noticed you stayed, and we want the ritual to get better.",
          "The gift can also be chosen to deepen the product itself. A whisk makes the matcha better. A proper cup makes the morning better. Each milestone gift can move the customer further into the routine your product lives inside, which is something no voucher code has ever done.",
        ],
      },
      {
        heading: "Why nobody does this by hand",
        paragraphs: [
          "The idea is old. The execution is miserable. Someone has to know which delivery number every customer is on, remember that a delivery only counts when the order actually processed, notice when a renewal date moves, and get the gift into the right parcel without charging for it or breaking the fulfilment flow.",
          "Do that for four hundred subscribers across a dozen products and it stops being a nice gesture and becomes a spreadsheet job that quietly gets abandoned by March.",
          "That is the job Reloop does. It counts every successful delivery per customer per product line, and when someone reaches a milestone you have chosen, it places a free gift line on their next renewal so the gift ships inside the box they were already getting. No codes, no separate parcels, no spreadsheet.",
        ],
      },
    ],
  },
  {
    slug: "how-a-gift-gets-into-the-box",
    title: "How a free gift gets inside a Recharge renewal",
    description: "The mechanics of placing a real product in a renewal order at zero cost, without touching prices or fulfilment.",
    date: "2026-09-05",
    readMinutes: 5,
    sections: [
      {
        paragraphs: [
          "When Reloop decides a customer has earned a gift, something very specific happens in Recharge, and it is worth understanding exactly what, because the boring details are what make the whole thing safe.",
        ],
      },
      {
        heading: "The gift is a real product at a price of zero",
        paragraphs: [
          "Every gift in Reloop is linked to a product that already exists in your store. The whisk is a real whisk with a real product page and a real price for anyone who wants to buy one. Reloop never creates products, never edits them, and never changes a price.",
          "Instead, it adds the gift to the customer's upcoming renewal as an extra line at a price of zero, pinned to the exact date of that renewal. When the renewal charges, the order that flows to your store and on to fulfilment contains the subscription product plus the gift, priced at nothing. Your warehouse packs what the order says. The gift rides along in the same box.",
        ],
      },
      {
        heading: "Pinned to a date, not to hope",
        paragraphs: [
          "Reloop pins each gift to the renewal's exact charge date rather than vaguely attaching it to whatever charge comes next. If the customer moves their renewal, the pin no longer matches, the gift is held, and Reloop reschedules it once the new date is confirmed. A customer who delays a month does not accidentally get their gift on the wrong order, and a customer who cancels does not get a gift at all.",
        ],
      },
      {
        heading: "Checked before, verified after",
        paragraphs: [
          "Immediately before writing anything, Reloop rechecks everything against live data: the subscription is still active, the renewal date still matches, the gift was not already added, the product link is still valid. Only then does it write, exactly once.",
          "Immediately after, it reads the result back from Recharge and compares every field: the date, the product, the quantity, the zero price. Only when the readback matches does Reloop count the gift as added. If anything looks different, it stops and raises its hand rather than guessing.",
          "The result is a system that has to prove a write was correct before it believes its own database, which is the standard you want from software that touches real customer orders.",
        ],
      },
    ],
  },
  {
    slug: "test-mode-first",
    title: "Test mode first: earning trust before writing anything",
    description: "Reloop rehearses every gift against live data and shows you exactly what it would do, for as long as you like, before it is allowed to act.",
    date: "2026-09-08",
    readMinutes: 4,
    sections: [
      {
        paragraphs: [
          "Software that writes to your store should have to earn that right. Reloop is built around a simple idea: you should be able to watch it think for weeks before you let it act.",
        ],
      },
      {
        heading: "Rehearsals, not simulations",
        paragraphs: [
          "In test mode, Reloop does the entire job except the final write. It imports your subscriptions, counts every delivery, plans every gift, and then rehearses each one against live data: is the subscription active, is the renewal date right, does the gift product still exist, would the write succeed.",
          "Every rehearsal produces a preview of the exact gift line it would create, down to the field. You can open any queued gift and read precisely what would happen and when. Nothing is written anywhere.",
        ],
      },
      {
        heading: "Going live changes one thing",
        paragraphs: [
          "When you switch to live, the checks do not relax. The same rehearsal runs immediately before every write, only gifts whose product links have been verified are eligible, and every write is read back and confirmed field by field before it counts.",
          "Anything that cannot pass its checks simply stays queued with a plain explanation of what is blocking it. Anything unexpected stops and appears in your attention list. The system prefers asking to guessing, every time.",
        ],
      },
      {
        heading: "Why we built it this way",
        paragraphs: [
          "Reloop runs against real stores with real customers, where a wrong write is not a bug report but somebody's order. Building the cautious version first meant our first ever live gifts went out verified, on the right renewals, at a price of zero, with an audit trail for every decision. That is the only way we would want software behaving inside our own store, so it is how Reloop behaves in yours.",
        ],
      },
    ],
  },
];

export function getPost(slug: string): Post | undefined {
  return posts.find((p) => p.slug === slug);
}

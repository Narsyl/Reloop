import { blockerSentence } from "@/lib/status";
import { ordinal } from "@/lib/format";

/**
 * Display-layer rewriting of stored activity summaries into merchant sentences.
 * The stored summary is the audit record and is never changed; when a rewrite
 * applies, the original stays available as a tooltip. Unknown formats fall back
 * to a light punctuation cleanup so nothing ever renders raw event plumbing.
 */
export function humanizeActivity(eventType: string, summary: string): { text: string; changed: boolean } {
  const specific = specificRewrite(eventType, summary);
  if (specific) return { text: specific, changed: true };
  const cleaned = genericCleanup(summary);
  return { text: cleaned, changed: cleaned !== summary };
}

function specificRewrite(eventType: string, s: string): string | null {
  switch (eventType) {
    case "ACTION_DRY_RUN": {
      const m = s.match(/^Dry run for (.+?) · (.+?) delivery (\d+)(?: \(.+?\))?: (.+)$/);
      if (!m) return null;
      const [, name, program, cycle, outcome] = m;
      const head = `Checked ${name}'s ${ordinal(Number(cycle))} ${program} delivery.`;
      const blocked = outcome.match(/would NOT execute — ([A-Z_]+)/);
      if (blocked) return `${head} On hold: ${blockerSentence(blocked[1])}`;
      const date = outcome.match(/on (\d{4}-\d{2}-\d{2})/);
      return `${head} The gift is ready${date ? ` for the ${date[1]} renewal` : ""}.`;
    }
    case "ACTION_PLANNED":
    case "MARKER_QUEUED": {
      const m = s.match(/^Planned (?:\(dry run\) )?['"]?(.+?)['"]?(?: \(Shopify .+?\))? for (.+?) · (.+?)[,·] ?delivery (\d+)/);
      if (!m) return null;
      const [, reward, name, program, cycle] = m;
      const date = s.match(/(?:target charge|on) (\d{4}-\d{2}-\d{2})/);
      return `Planned the ${reward} for ${name}'s ${ordinal(Number(cycle))} ${program} delivery${date ? `, renewing ${date[1]}` : ""}.`;
    }
    case "ACTION_REPLANNED": {
      const m = s.match(/^Replanned (.+?) for (.+?): target charge .+? → (\S+)$/);
      if (!m) return null;
      return `Moved ${m[2]}'s ${m[1]} to the ${m[3]} renewal.`;
    }
    case "ACTION_CANCELLED": {
      const m = s.match(/^Cancelled planned action for (?:.+?) · delivery (\d+): ([A-Z_]+)/);
      if (!m) return null;
      return `Cancelled a planned gift for the ${ordinal(Number(m[1]))} delivery. ${blockerSentence(m[2])}`;
    }
    case "ACTION_SUPERSEDED":
      return "The journey changed, so a newer planned gift replaced this one.";
    case "ACTION_ATTACHED": {
      const date = s.match(/charge (\d{4}-\d{2}-\d{2})/);
      return `Gift added to the ${date ? `${date[1]} ` : ""}renewal in Recharge.`;
    }
    case "MARKER_ATTACHED": {
      const m = s.match(/^Attached ['"](.+?)['"] to (.+?)'s upcoming (.+?) shipment \((\d{4}-\d{2}-\d{2})\)/);
      if (!m) return null;
      return `${m[1]} added to ${m[2]}'s ${m[3]} renewal on ${m[4]}.`;
    }
    case "CYCLE_COMPLETED": {
      const m = s.match(/^(.+?) · (.+?): delivery (\d+) processed$/);
      if (!m) return null;
      return `${m[1]}'s ${ordinal(Number(m[3]))} ${m[2]} delivery processed.`;
    }
    case "SYNC_FAILED": {
      const m = s.match(/^Sync failed at stage ([A-Z_]+)/);
      if (!m) return null;
      return `A sync attempt failed while ${STAGE_LABEL[m[1]] ?? "running"}. It will retry automatically.`;
    }
    case "SYNC_COMPLETED": {
      const first = s.split(/[;.]/)[0];
      return `${genericCleanup(first)}.`;
    }
    default:
      return null;
  }
}

const STAGE_LABEL: Record<string, string> = {
  CONNECTING: "connecting to Recharge",
  CUSTOMERS: "importing customers",
  PRODUCTS: "importing products",
  SUBSCRIPTIONS: "importing subscriptions",
  ORDERS: "importing orders",
  JOURNEYS: "recalculating journeys",
};

function genericCleanup(s: string): string {
  return s
    .split(" · ").join(", ")
    .split(" — ").join(". ")
    .split(" → ").join(" to ")
    .split("→").join(" to ")
    .replace(/\s{2,}/g, " ")
    .trim();
}


/** One sentence of advice per exception type: what the merchant should do next. */
export function exceptionAdvice(type: string): string {
  switch (type) {
    case "MARKER_PRODUCT_MISSING":
      return "Check that the gift product still exists in Shopify, then verify it again under Rewards.";
    case "PRODUCT_MAPPING_MISSING":
      return "Add the product to a programme under Settings so deliveries start counting.";
    case "CHARGE_DATE_MOVED":
      return "Nothing to do. The gift moved with the renewal, and this is just confirming it.";
    case "MAPPING_BROKEN":
      return "Reassign the product to a programme under Settings, then the journey will be recalculated.";
    case "CONTROLLED_TEST_READBACK_MISMATCH":
      return "Compare the one-time in Recharge with the intended payload in the gift's technical details before anything else is written.";
    default:
      return "Open the linked subscription and compare it against Recharge before resolving.";
  }
}

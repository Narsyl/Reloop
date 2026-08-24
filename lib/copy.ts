import { ordinal } from "@/lib/format";

/** Merchant sentence for a queued gift. Plain words, no jargon, no dashes, no pronoun guesses. */
export function giftSentence(a: { targetCycle: number; rewardItem: { name: string } | null; fulfillmentMarker: { name: string } | null; journey: { program: { name: string } } }): string {
  const reward = a.rewardItem?.name ?? a.fulfillmentMarker?.name ?? "Gift";
  return `${reward} with the ${ordinal(a.targetCycle)} ${a.journey.program.name} delivery`;
}

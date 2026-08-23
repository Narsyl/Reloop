/**
 * The exact POST /onetimes body — ONE builder shared by the DRY_RUN preview and the Phase 6
 * executor, so what the operator approved in the preview is byte-for-byte what gets sent.
 *
 * Design locked in Phase 4/6:
 *   - next_charge_scheduled_at = the action's verified target charge date (exact-date pinning;
 *     never add_to_next_charge — auditability + protection against attaching to a moved charge)
 *   - price "0.00", quantity 1 — the reward is free regardless of the variant's retail price
 *   - properties carry the action id (+ reward name) for reconciliation and audit
 */
import type { RechargeOnetimeCreateBody } from "@/lib/integrations/recharge/onetimes";

export const ACTION_PROPERTY = "_subscription_ops_action";
export const REWARD_PROPERTY = "_subscription_ops_reward";

export type OnetimeTarget = { externalVariantId: string; externalProductId: string | null; title: string };

export function buildOnetimeBody(input: { addressId: string; targetChargeDate: string; target: OnetimeTarget; actionId: string; rewardName: string | null }): RechargeOnetimeCreateBody {
  const { addressId, targetChargeDate, target, actionId, rewardName } = input;
  return {
    address_id: /^[0-9]+$/.test(addressId) ? Number(addressId) : addressId,
    next_charge_scheduled_at: targetChargeDate,
    external_variant_id: { ecommerce: target.externalVariantId },
    ...(target.externalProductId ? { external_product_id: { ecommerce: target.externalProductId } } : {}),
    product_title: target.title,
    quantity: 1,
    price: "0.00",
    properties: [{ name: ACTION_PROPERTY, value: actionId }, ...(rewardName ? [{ name: REWARD_PROPERTY, value: rewardName }] : [])],
  };
}

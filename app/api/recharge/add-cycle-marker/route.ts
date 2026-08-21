import { NextRequest, NextResponse } from "next/server";
import { rechargeFetch } from "@/lib/recharge";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));

    const subscriptionId = body?.subscriptionId;

    if (!subscriptionId) {
      return NextResponse.json(
        { success: false, error: "subscriptionId is required" },
        { status: 400 }
      );
    }

    /*
     * STEP 1
     *
     * Load THIS specific subscription so we know its
     * address and its exact next renewal date.
     */
    const subscriptionData = await rechargeFetch(
      `/subscriptions/${subscriptionId}`
    );

    const subscription = subscriptionData.subscription;

    if (!subscription) {
      return NextResponse.json(
        { success: false, error: "Subscription not found" },
        { status: 404 }
      );
    }

    if (subscription.status !== "active") {
      return NextResponse.json(
        {
          success: false,
          error: `Subscription is not active (status: ${subscription.status})`,
        },
        { status: 400 }
      );
    }

    if (!subscription.next_charge_scheduled_at) {
      return NextResponse.json(
        {
          success: false,
          error: "Subscription has no next_charge_scheduled_at",
        },
        { status: 400 }
      );
    }

    /*
     * STEP 2
     *
     * Resolve the gift product config from the server env.
     */
    const giftVariantId = process.env.MORNING_MAGIC_2_VARIANT_ID;
    const giftSku = process.env.MORNING_MAGIC_2_SKU || "MM-CYCLE-02";
    const giftTitle =
      process.env.MORNING_MAGIC_2_TITLE || "Morning Magic 2";

    if (!giftVariantId) {
      throw new Error(
        "MORNING_MAGIC_2_VARIANT_ID is missing"
      );
    }

    /*
     * STEP 3
     *
     * Create the £0 one-time item on THE EXACT SAME
     * DATE as this particular subscription.
     *
     * We intentionally DON'T use add_to_next_charge.
     */
    const onetimeData = await rechargeFetch(
      "/onetimes",
      {
        method: "POST",

        body: JSON.stringify({
          address_id: subscription.address_id,

          next_charge_scheduled_at:
            subscription.next_charge_scheduled_at,

          external_variant_id: {
            ecommerce: String(giftVariantId),
          },

          quantity: 1,

          price: "0.00",

          product_title: giftTitle,

          sku: giftSku,
        }),
      }
    );

    return NextResponse.json({
      success: true,

      message:
        "Morning Magic 2 was added to the upcoming Recharge order.",

      subscription: {
        id: subscription.id,
        productTitle: subscription.product_title,
        nextCharge:
          subscription.next_charge_scheduled_at,
        addressId: subscription.address_id,
      },

      marker: onetimeData.onetime,
    });
  } catch (error) {
    console.error("Add cycle marker failed:", error);

    return NextResponse.json(
      {
        success: false,

        error:
          error instanceof Error
            ? error.message
            : "Unknown error",
      },
      { status: 500 }
    );
  }
}

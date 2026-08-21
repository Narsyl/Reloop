import { NextRequest, NextResponse } from "next/server";
import { rechargeFetch } from "@/lib/recharge";

export async function GET(request: NextRequest) {
  try {
    const subscriptionId =
      request.nextUrl.searchParams.get("subscriptionId");

    if (!subscriptionId) {
      return NextResponse.json(
        { error: "subscriptionId is required" },
        { status: 400 }
      );
    }

    const data = await rechargeFetch(
      `/subscriptions/${subscriptionId}`
    );

    const subscription = data.subscription;

    return NextResponse.json({
      id: subscription.id,
      status: subscription.status,
      customerId: subscription.customer_id,
      addressId: subscription.address_id,

      productTitle: subscription.product_title,
      variantTitle: subscription.variant_title,
      sku: subscription.sku,

      quantity: subscription.quantity,
      price: subscription.price,

      nextChargeScheduledAt:
        subscription.next_charge_scheduled_at,

      externalProductId:
        subscription.external_product_id,

      externalVariantId:
        subscription.external_variant_id,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unknown error",
      },
      { status: 500 }
    );
  }
}

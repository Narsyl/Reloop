"use client";

import { useState } from "react";

type Subscription = {
  id: number;
  status: string;
  customerId: number;
  addressId: number;
  productTitle: string;
  variantTitle: string;
  sku: string;
  quantity: number;
  price: string;
  nextChargeScheduledAt: string | null;
  externalProductId?: unknown;
  externalVariantId?: unknown;
};

export default function Home() {
  const [subscriptionId, setSubscriptionId] = useState("");
  const [subscription, setSubscription] =
    useState<Subscription | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  async function loadSubscription() {
    if (!subscriptionId.trim()) {
      setMessage("Enter a Recharge subscription ID first.");
      return;
    }

    setLoading(true);
    setMessage("");
    setSubscription(null);

    try {
      const res = await fetch(
        `/api/recharge/subscription?subscriptionId=${encodeURIComponent(
          subscriptionId.trim()
        )}`
      );

      const data = await res.json();

      if (!res.ok) {
        setMessage(`Error: ${data.error || "Failed to load subscription"}`);
        return;
      }

      setSubscription(data);
    } catch (error) {
      setMessage(
        `Error: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    } finally {
      setLoading(false);
    }
  }

  async function addMorningMagic2() {
    if (!subscription) return;

    setLoading(true);
    setMessage("");

    try {
      const res = await fetch("/api/recharge/add-cycle-marker", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscriptionId: subscription.id }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        setMessage(`Error: ${data.error || "Failed to add Morning Magic 2"}`);
        return;
      }

      setMessage(
        `${data.message} (one-time ID: ${
          data.marker?.id ?? "unknown"
        }, scheduled for ${data.subscription?.nextCharge})`
      );
    } catch (error) {
      setMessage(
        `Error: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl font-bold tracking-tight">
        Ancient Extracts Subscription Engine
      </h1>

      <div className="mt-8">
        <label
          htmlFor="subscriptionId"
          className="block text-sm text-gray-500"
        >
          Recharge Subscription ID
        </label>

        <input
          id="subscriptionId"
          value={subscriptionId}
          onChange={(e) => setSubscriptionId(e.target.value)}
          placeholder="123456789"
          className="mt-2 w-full rounded-lg border px-4 py-3"
        />

        <button
          onClick={loadSubscription}
          disabled={loading}
          className="mt-4 rounded-lg border px-5 py-3 disabled:opacity-50"
        >
          {loading && !subscription
            ? "Loading…"
            : "Load subscription"}
        </button>
      </div>

      {subscription && (
        <div className="mt-8 rounded-xl border p-6">
          <h2 className="text-lg font-semibold">Subscription</h2>

          <dl className="mt-4 space-y-3">
            <div>
              <dt className="text-sm text-gray-500">
                Product
              </dt>
              <dd>
                {subscription.productTitle}
              </dd>
            </div>

            <div>
              <dt className="text-sm text-gray-500">
                Recharge Subscription ID
              </dt>
              <dd>{subscription.id}</dd>
            </div>

            <div>
              <dt className="text-sm text-gray-500">
                Status
              </dt>
              <dd>{subscription.status}</dd>
            </div>

            <div>
              <dt className="text-sm text-gray-500">
                Address ID
              </dt>
              <dd>{subscription.addressId}</dd>
            </div>

            <div>
              <dt className="text-sm text-gray-500">
                Next charge
              </dt>

              <dd className="font-semibold">
                {
                  subscription.nextChargeScheduledAt
                }
              </dd>
            </div>
          </dl>

          <button
            onClick={addMorningMagic2}
            disabled={loading}
            className="mt-6 rounded-lg bg-black px-5 py-3 text-white disabled:opacity-50"
          >
            Add Morning Magic 2
          </button>
        </div>
      )}

      {message && (
        <div className="mt-6 rounded-xl border p-4">
          {message}
        </div>
      )}
    </main>
  );
}

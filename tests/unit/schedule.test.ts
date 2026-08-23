import { describe, expect, it } from "vitest";
import { computeSchedule } from "@/lib/domain/actions/schedule";
import { liveKeyFor, ownerKeyFor } from "@/lib/domain/actions/keys";
import { localMidnightUtc } from "@/lib/domain/time";

describe("D6 schedule maths", () => {
  it("target charge 28 Aug (Europe/London, BST) → local midnight 27 Aug 23:00Z; execute after = −72h (25 Aug 00:00 local)", () => {
    const s = computeSchedule({ targetChargeDate: "2026-08-28", timezone: "Europe/London", markerLeadHours: 72, now: new Date("2026-08-23T15:00:00Z") });
    expect(s.targetChargeAt.toISOString()).toBe("2026-08-27T23:00:00.000Z");
    expect(s.executeAfter.toISOString()).toBe("2026-08-24T23:00:00.000Z");
    expect(s.insideWindow).toBe(false);
  });
  it("winter dates use GMT (no DST offset)", () => {
    expect(localMidnightUtc("2026-12-10", "Europe/London").toISOString()).toBe("2026-12-10T00:00:00.000Z");
    expect(localMidnightUtc("2026-12-10", "America/New_York").toISOString()).toBe("2026-12-10T05:00:00.000Z");
  });
  it("inside the lead window → execute after = now", () => {
    const now = new Date("2026-08-27T10:00:00Z");
    const s = computeSchedule({ targetChargeDate: "2026-08-28", timezone: "Europe/London", markerLeadHours: 72, now });
    expect(s.insideWindow).toBe(true);
    expect(s.executeAfter.toISOString()).toBe(now.toISOString());
  });
  it("respects a different lead setting", () => {
    const s = computeSchedule({ targetChargeDate: "2026-08-28", timezone: "Europe/London", markerLeadHours: 24, now: new Date("2026-08-20T00:00:00Z") });
    expect(s.executeAfter.toISOString()).toBe("2026-08-26T23:00:00.000Z");
  });
  it("rejects non date-only input", () => {
    expect(() => computeSchedule({ targetChargeDate: "2026-08-28T00:00:00Z", timezone: "Europe/London", markerLeadHours: 72, now: new Date() })).toThrow();
  });
});

describe("idempotency keys", () => {
  it("liveKey is journey:cycle:marker; ownerKey follows the rule scope", () => {
    expect(liveKeyFor("j1", 2, "m1")).toBe("j1:2:m1");
    expect(ownerKeyFor({ scope: "PER_SUBSCRIPTION", journeyId: "j1", customerId: "c1", programId: "p1", targetCycle: 2, rewardId: "m1" })).toBe("j:j1:2:m1");
    expect(ownerKeyFor({ scope: "CUSTOMER_PROGRAM", journeyId: "j1", customerId: "c1", programId: "p1", targetCycle: 2, rewardId: "m1" })).toBe("c:c1:p1:2:m1");
    // customer-programme rule on a subscription without a customer link degrades to journey ownership
    expect(ownerKeyFor({ scope: "CUSTOMER_PROGRAM", journeyId: "j1", customerId: null, programId: "p1", targetCycle: 2, rewardId: "m1" })).toBe("j:j1:2:m1");
  });
});

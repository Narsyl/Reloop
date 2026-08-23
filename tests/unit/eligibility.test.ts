import { describe, expect, it } from "vitest";
import { evaluateJourneyEligibility, evaluateJourneyEligibilityIgnoringMode, type EligibilityInput } from "@/lib/domain/eligibility/evaluate";
import { qualifyForRule } from "@/lib/domain/eligibility/qualify";
import { validateRuleConfig, CYCLE_ONE_EXPLANATION } from "@/lib/domain/rules/validation";

const base = (): EligibilityInput => ({
  subscription: { status: "ACTIVE", mappingStatus: "MAPPED", nextChargeDate: "2026-09-21", latestJourneyId: "j1", automationOverride: null },
  journey: { id: "j1", endedAt: null, programId: "prog" },
  resolvedProgramId: "prog",
  integration: { status: "CONNECTED", automationMode: "DRY_RUN" },
});

describe("evaluateJourneyEligibility (layer A)", () => {
  it("valid actionable state", () => {
    expect(evaluateJourneyEligibility(base())).toEqual({ eligible: true, reasons: [] });
  });
  it("inactive / cancelled subscription", () => {
    const r = evaluateJourneyEligibility({ ...base(), subscription: { ...base().subscription, status: "CANCELLED" } });
    expect(r.eligible).toBe(false);
    expect(!r.eligible && r.reason).toBe("SUBSCRIPTION_NOT_ACTIVE");
  });
  it("ended journey", () => {
    const r = evaluateJourneyEligibility({ ...base(), journey: { id: "j1", endedAt: new Date(), programId: "prog" } });
    expect(!r.eligible && r.reason).toBe("JOURNEY_ENDED");
  });
  it("not-latest journey", () => {
    const r = evaluateJourneyEligibility({ ...base(), journey: { id: "j0", endedAt: null, programId: "prog" } });
    expect(!r.eligible && r.reason).toBe("NOT_LATEST_JOURNEY");
  });
  it("unmapped", () => {
    const r = evaluateJourneyEligibility({ ...base(), subscription: { ...base().subscription, mappingStatus: "UNMAPPED" } });
    expect(!r.eligible && r.reason).toBe("UNMAPPED");
  });
  it("broken programme mapping (was mapped, current product resolves elsewhere or nowhere)", () => {
    expect(!(evaluateJourneyEligibility({ ...base(), resolvedProgramId: null }) as { eligible: false; reason: string }).eligible).toBe(true);
    const r = evaluateJourneyEligibility({ ...base(), resolvedProgramId: "other" });
    expect(!r.eligible && r.reason).toBe("BROKEN_MAPPING");
  });
  it("no upcoming charge (AE 805925419)", () => {
    const r = evaluateJourneyEligibility({ ...base(), subscription: { ...base().subscription, nextChargeDate: null } });
    expect(!r.eligible && r.reason).toBe("NO_UPCOMING_CHARGE");
  });
  it("integration automation OFF (and override ENABLED lifts it)", () => {
    const off = evaluateJourneyEligibility({ ...base(), integration: { status: "CONNECTED", automationMode: "OFF" } });
    expect(!off.eligible && off.reason).toBe("AUTOMATION_OFF");
    const lifted = evaluateJourneyEligibility({ ...base(), integration: { status: "CONNECTED", automationMode: "OFF" }, subscription: { ...base().subscription, automationOverride: "ENABLED" } });
    expect(lifted.eligible).toBe(true);
    const ignoring = evaluateJourneyEligibilityIgnoringMode({ ...base(), integration: { status: "CONNECTED", automationMode: "OFF" } });
    expect(ignoring.eligible).toBe(true);
  });
  it("integration not connected / blocking exception", () => {
    expect((evaluateJourneyEligibility({ ...base(), integration: { status: "ERROR", automationMode: "LIVE" } }) as { reason: string }).reason).toBe("INTEGRATION_NOT_CONNECTED");
    expect((evaluateJourneyEligibility({ ...base(), blockingExceptions: 1 }) as { reason: string }).reason).toBe("BLOCKING_EXCEPTION");
  });
  it("reports ALL failing conditions, most fundamental first", () => {
    const r = evaluateJourneyEligibility({ ...base(), subscription: { status: "CANCELLED", mappingStatus: "UNMAPPED", nextChargeDate: null, latestJourneyId: "j1" }, journey: { id: "j1", endedAt: new Date(), programId: "prog" } });
    expect(!r.eligible && r.reasons).toEqual(["SUBSCRIPTION_NOT_ACTIVE", "JOURNEY_ENDED", "UNMAPPED", "NO_UPCOMING_CHARGE"]);
  });
});

describe("qualifyForRule (layer B)", () => {
  const rule = { status: "ACTIVE" as const, programId: "prog", cycleNumber: 2, eligibilityScope: "PER_SUBSCRIPTION" as const };
  it("qualifies when the next delivery is the milestone", () => {
    expect(qualifyForRule({ rule, journey: { programId: "prog", successfulCycles: 1 } })).toEqual({ qualifies: true, timing: "NOW" });
  });
  it("future-only before the previous delivery; never when already past", () => {
    expect(qualifyForRule({ rule, journey: { programId: "prog", successfulCycles: 0 } })).toMatchObject({ qualifies: false, reason: "NOT_NEXT_CYCLE", timing: "FUTURE" });
    expect(qualifyForRule({ rule, journey: { programId: "prog", successfulCycles: 5 } })).toMatchObject({ qualifies: false, reason: "MILESTONE_ALREADY_PASSED", timing: "NEVER" });
  });
  it("wrong programme / inactive rule / scope missing / action exists", () => {
    expect(qualifyForRule({ rule, journey: { programId: "other", successfulCycles: 1 } })).toMatchObject({ reason: "WRONG_PROGRAM" });
    expect(qualifyForRule({ rule: { ...rule, status: "READY" }, journey: { programId: "prog", successfulCycles: 1 } })).toMatchObject({ reason: "RULE_NOT_ACTIVE" });
    expect(qualifyForRule({ rule: { ...rule, eligibilityScope: null }, journey: { programId: "prog", successfulCycles: 1 } })).toMatchObject({ reason: "SCOPE_NOT_CHOSEN" });
    expect(qualifyForRule({ rule, journey: { programId: "prog", successfulCycles: 1 }, existingLiveAction: true })).toMatchObject({ reason: "ACTION_EXISTS" });
  });
  it("CUSTOMER_PROGRAM: Danielle — cancelled sub 10 + new sub 2 → lifetime 12 → cycle-2 rule does not fire again", () => {
    const cust = { ...rule, eligibilityScope: "CUSTOMER_PROGRAM" as const };
    // new subscription at cycle 1 (about to take delivery 2) but lifetime deliveries 11
    expect(qualifyForRule({ rule: cust, journey: { programId: "prog", successfulCycles: 1 }, customerLifetimeDeliveries: 11 })).toMatchObject({ qualifies: false, reason: "CUSTOMER_ALREADY_REACHED_MILESTONE" });
    // per-subscription view of the same customer qualifies
    expect(qualifyForRule({ rule, journey: { programId: "prog", successfulCycles: 1 }, customerLifetimeDeliveries: 11 })).toMatchObject({ qualifies: true });
    // brand-new customer: lifetime == subscription cycles
    expect(qualifyForRule({ rule: cust, journey: { programId: "prog", successfulCycles: 1 }, customerLifetimeDeliveries: 1 })).toMatchObject({ qualifies: true });
    // a cycle-12 rule WOULD fire for Danielle under CUSTOMER_PROGRAM (lifetime 11 → next is 12)
    expect(qualifyForRule({ rule: { ...cust, cycleNumber: 12 }, journey: { programId: "prog", successfulCycles: 1 }, customerLifetimeDeliveries: 11 })).toMatchObject({ qualifies: true });
  });
  it("CUSTOMER_PROGRAM with two simultaneous subscriptions in the programme: lifetime counts both, evaluated per journey", () => {
    const cust = { ...rule, eligibilityScope: "CUSTOMER_PROGRAM" as const, cycleNumber: 3 };
    // sub A at 1, sub B at 1 → lifetime 2 → next lifetime delivery is 3 → qualifies (whichever ships next)
    expect(qualifyForRule({ rule: cust, journey: { programId: "prog", successfulCycles: 1 }, customerLifetimeDeliveries: 2 })).toMatchObject({ qualifies: true });
    // but per-subscription, each is only at cycle 1 → delivery 3 is future-only
    expect(qualifyForRule({ rule: { ...rule, cycleNumber: 3 }, journey: { programId: "prog", successfulCycles: 1 } })).toMatchObject({ reason: "NOT_NEXT_CYCLE" });
  });
});

describe("validateRuleConfig", () => {
  it("rejects cycle 1 with the human explanation", () => {
    const issues = validateRuleConfig({ name: "x", programId: "p", cycleNumber: 1, fulfillmentMarkerId: "m", eligibilityScope: "PER_SUBSCRIPTION" });
    expect(issues.map((i) => i.code)).toContain("CYCLE_TOO_LOW");
    expect(issues.find((i) => i.code === "CYCLE_TOO_LOW")?.message).toBe(CYCLE_ONE_EXPLANATION);
  });
  it("scope missing blocks READY", () => {
    const issues = validateRuleConfig({ name: "Rule", programId: "p", cycleNumber: 2, fulfillmentMarkerId: "m", eligibilityScope: null });
    expect(issues).toEqual([expect.objectContaining({ code: "SCOPE_REQUIRED", blocksReady: true })]);
  });
});

# Reward schedules — architecture amendment (approved and implemented, 23 Aug 2026)

Status: **implemented** (see `docs/ARCHITECTURE.md` §25) with these approved amendments over the original proposal: no platform gift enum — organisation-owned **`RewardItem`** (name, description, operationalDescription, active); `RewardScheduleMilestone.rewardItemId` instead of giftType/giftLabel; `FulfillmentMarker.rewardItemId` + `operationalNote`; bindings reference the milestone explicitly (`ProgramMilestoneMarker(programId, rewardScheduleMilestoneId, fulfillmentMarkerId)`, unique per programme + milestone, resolver verifies schedule membership / store / reward match / not placeholder / active); reward is once per **programme** (no `CUSTOMER_SCHEDULE`); CUSTOMER_PROGRAM for all Schedule A and B milestones; Matcha and Soursop continuous product ids mapped; Butterfly Pea standalone product only; Hojicha documented only; `INITIAL_CHECKOUT` milestones recorded and never planned by the renewal planner (delivery-1 gifts are solved by a starter product / future safe subscription swap, never by post-order edits). The text below is the original proposal, kept for the reasoning.

## 0. Corrections this amendment encodes

- "Morning Magic delivery 2 → whisk" is **wrong** and is removed. Morning Magic / Evening Elixir: delivery 1 → **whisk**, 2 → **cup**, 3 → **spoon**.
- Mushroom / Matcha-and-coloured-powders / Soursop: delivery 2 → **whisk**, 3 → **cup**.
- A fulfilment marker titled "Morning Magic 2" therefore means **include cup**; "Morning Magic 3" means **include spoon**.
- Delivery-1 gifts cannot be produced by the renewal planner (the first order already exists downstream when we learn of it); they are a separate execution mode, **not implemented now**.

## 1. `RewardSchedule`

```prisma
enum RewardScheduleStatus { DRAFT READY ARCHIVED }   // no ACTIVE: live execution stays unreachable

model RewardSchedule {
  id             String               @id @default(cuid())
  organizationId String
  name           String               // "Schedule A — Whisk at 2, Cup at 3"
  description    String?
  status         RewardScheduleStatus @default(DRAFT)   // DRAFT = being configured; READY = usable by the dry-run planner; ARCHIVED = inactive
  createdById    String?
  createdAt      DateTime             @default(now())
  updatedAt      DateTime             @updatedAt
  organization   Organization         @relation(...)
  milestones     RewardScheduleMilestone[]
  programs       SubscriptionProgram[]
  @@unique([organizationId, name])
}
```

Reusable, organisation-scoped, ordered by its milestones' delivery numbers. Same DRAFT → READY gate the rules had; ACTIVE deliberately does not exist.

## 2. `RewardScheduleMilestone`

```prisma
enum GiftType { WHISK CUP SPOON OTHER }
enum MilestoneExecutionMode { UPCOMING_RENEWAL INITIAL_CHECKOUT }

model RewardScheduleMilestone {
  id               String                 @id @default(cuid())
  organizationId   String
  scheduleId       String
  cycleNumber      Int                    // delivery number this gift belongs to
  giftType         GiftType               // what is physically included (operator meaning)
  giftLabel        String?                // free text when giftType = OTHER, or a note ("bamboo whisk")
  executionMode    MilestoneExecutionMode // INITIAL_CHECKOUT only for cycleNumber = 1 (DB CHECK), UPCOMING_RENEWAL for ≥ 2
  eligibilityScope EligibilityScope       // REQUIRED — PER_SUBSCRIPTION | CUSTOMER_PROGRAM (see §4)
  active           Boolean                @default(true)
  notes            String?
  schedule         RewardSchedule         @relation(...)
  @@unique([scheduleId, cycleNumber])
}
-- CHECK ((cycleNumber = 1) = (executionMode = 'INITIAL_CHECKOUT'))   -- delivery 1 is never renewal-planned; renewal milestones begin at 2
```

Order = `cycleNumber`; no separate position column. "Active/inactive" per milestone lets a schedule drop a gift without deleting history.

## 3. Programme → schedule link, and programme-specific markers

- `SubscriptionProgram.rewardScheduleId String?` (FK, `onDelete: SetNull`) + `rewardScheduleAssignedAt DateTime?`. **One schedule per programme, assignment = FK.** A join model would only add a place for drift; V1 needs neither effective-dated history nor concurrent schedules. Changing the assignment is an audited action; the planner reconciles existing actions (keys are physical — §9). If dated assignments are ever needed the FK migrates into a join without touching the planner.
- `ProgramMilestoneMarker { id, organizationId, programId, cycleNumber, fulfillmentMarkerId, active } @@unique([programId, cycleNumber])` — the **binding**: which physical marker this programme uses for schedule slot N. Many programmes may bind the same marker (a shared "Whisk" variant) or each its own ("Chaga 2", "Ube 2"). This is the only per-programme configuration besides the schedule choice. A binding is valid only when `marker.giftType = milestone.giftType`.

```text
SubscriptionProgram ──rewardScheduleId──▶ RewardSchedule ──▶ RewardScheduleMilestone (cycle, gift, mode, scope)
        │                                                           │
        └── ProgramMilestoneMarker (programme × cycle) ──▶ FulfillmentMarker (variant, giftType) ◀── must match gift
```

## 4. Where `eligibilityScope` lives — **B, on the milestone, required**

- Scope is a property of the reward intent ("is the cup a customer milestone or a subscription milestone?"); the milestone is the unit the planner resolves and the unit that carries idempotency (`ownerKey`). Putting it there keeps it explicit exactly where the reward is defined, and lets a later milestone (e.g. a delivery-12 loyalty gift) use a different scope in the same schedule.
- Not the schedule (A): forces every milestone to share one scope — too coarse for later milestones.
- Not the assignment (C): programmes sharing a schedule would diverge in reward semantics, which contradicts what "shared schedule" means; if a programme genuinely needs different semantics it gets a different schedule (cheap). C can be added later as an optional override without schema pain.
- Unchanged policy: no default value — chosen when the milestone is created. Proposed for Ancient Extracts: **CUSTOMER_PROGRAM on every early-lifecycle milestone** (Morning Magic already approved; Evening Elixir and all Schedule A milestones proposed the same — **confirm**).
- Open policy question (see §10): "whisk once per programme" vs "whisk once per customer across all Schedule A programmes".

## 5. What happens to `AutomationRule`

Retired as authored configuration. The planner consumes **effective milestones resolved at plan time** (programme → schedule → milestone → binding → marker); it does not read rules. Why not "generated rules": two representations of one fact is exactly the duplicated structure to avoid, and it needs a regeneration step that can drift. What is kept:

- the table stays for one more phase as **legacy, read-only** (all rows ARCHIVED, hidden behind a "legacy rules" section, each pointing at the milestone it became) so audit rows and links keep working; dropped in a later cleanup migration once schedules are proven;
- `AutomationAction.ruleId` stays nullable (legacy), and `AutomationAction.rewardScheduleMilestoneId` + `programId` are added for audit;
- `milestoneKey` (org+programme+cycle) is replaced by construction: `@@unique([scheduleId, cycleNumber])` + one schedule per programme + `@@unique([programId, cycleNumber])` binding ⇒ exactly one effective milestone per programme and delivery;
- DRAFT/READY move to the schedule; per-programme readiness is **computed** (schedule READY, milestone active, binding present, marker active, not placeholder, gift matches) and shown on the schedule page, never stored.

## 6. Migrating the existing Morning Magic delivery-2 DRAFT rule (audit preserved)

1. Create `RewardSchedule` "Schedule B — Morning Magic / Evening Elixir" (DRAFT) with milestones 1 WHISK INITIAL_CHECKOUT CUSTOMER_PROGRAM, 2 CUP UPCOMING_RENEWAL CUSTOMER_PROGRAM, 3 SPOON UPCOMING_RENEWAL CUSTOMER_PROGRAM.
2. Assign Morning Magic Powder and Evening Elixir Mushroom Cacao → Schedule B (audited).
3. Create binding Morning Magic × 2 → the **existing placeholder marker** (same id `cmt3fkoeo0005gf4ofi9rso0q`, still `placeholder=true`, still non-executable); set its `giftType = CUP`, `operationalNote = "Include cup — Morning Magic 2"`.
4. Mark the rule ARCHIVED, write `ActivityLog RULE_MIGRATED_TO_SCHEDULE {ruleId, scheduleId, milestoneId}`; every existing `RULE` activity row (created, scope set, READY refused, etc.) is untouched; the rule detail page shows "migrated to Schedule B · delivery 2 (cup)".
5. No action rows exist for it, so nothing else moves. No Recharge write.

## 7. `FulfillmentMarker` — physical identity + operational meaning

Keep the marker as the physical identity (integration-scoped external variant, title/SKU as the warehouse sees them) and add:

- `giftType GiftType?` — the internal meaning ("Morning Magic 2 → CUP", "Chaga 2 → WHISK");
- `operationalNote String?` — one line for operators/audit ("Include cup").

The marker's **name/title stays programme/cycle-specific by warehouse convention** ("Morning Magic 2"); the model does not force it — a tenant may bind one "Whisk" marker to many programmes. No inventory concepts. Binding validation (`marker.giftType = milestone.giftType`) is the only new rule; `placeholder` keeps its meaning (never executable).

## 8. Planner resolution without duplicated rules

Pure function `resolveEffectiveMilestones(ctx, programId)` → `[{ milestone, cycleNumber, giftType, executionMode, eligibilityScope, binding?, marker?, readiness: "READY" | reasons[] }]` from the programme's schedule. The planner (unchanged otherwise) iterates effective milestones with `executionMode = UPCOMING_RENEWAL` and `readiness = READY`; everything else is reported in the run (`milestonesSkipped: MILESTONE_INACTIVE | SCHEDULE_NOT_READY | NO_MARKER_BINDING | MARKER_PLACEHOLDER | MARKER_INACTIVE | GIFT_MISMATCH | INITIAL_CHECKOUT_NOT_PLANNED`). `qualifyForRule` already takes `{status, programId, cycleNumber, eligibilityScope}` — it is fed the effective milestone (schedule status + milestone fields); rename to `qualifyForMilestone` later.

```text
Subscription → latest Journey → SubscriptionProgram → RewardSchedule → next delivery N
  → milestone(N) → ProgramMilestoneMarker(programme, N) → FulfillmentMarker → eligibility scope → AutomationAction
```

## 9. CUSTOMER_PROGRAM idempotency — unchanged

- Lifetime deliveries = distinct `JourneyCycle` evidence per **customer + programme** (same loader the impact analysis uses).
- `ownerKey = c:<customer>:<programme>:<cycle>:<marker>` (or `j:<journey>:<cycle>:<marker>` for PER_SUBSCRIPTION) and `liveKey = journey:cycle:marker` are **physical** keys: swapping a programme's schedule does not duplicate a gift; changing a binding's marker supersedes the old action (existing Phase 4 behaviour, §10 of the architecture). Reward eligibility stays a separate layer; subscriptions and journeys are never merged.

## 10. Many programmes sharing Schedule A without merging histories

Lifecycle continuity is per programme and untouched (Chaga journeys ≠ Ube journeys; a Chaga → Tremella product change is a PROGRAM_CHANGE and starts a new journey at 0, exactly as today). The schedule is configuration only; the planner evaluates each programme's population separately and plans Chaga 2 / Tremella 2 independently. **Policy to confirm:** with CUSTOMER_PROGRAM, a customer who had the whisk at Chaga delivery 2 and later subscribes to Tremella would receive the whisk again at Tremella delivery 2 (different programme, lifetime 0 there). If the whisk is meant to be once per customer across the whole family, that is a third scope — `CUSTOMER_SCHEDULE` (lifetime counted across programmes sharing the schedule) — which the population loader can support later. Proposed V1: per programme, as framed; add `CUSTOMER_SCHEDULE` only if you want the cross-family rule.

## 11. First-delivery gifts (`INITIAL_CHECKOUT`) — safest approach (analysis only, not built)

Rejected: anything that edits after the order exists (Recharge creates the Shopify order → we notice → we edit) — the Royal Mail import race you described. That includes "add a one-time when `subscription/created` arrives": the first order is created at checkout in the same instant.

Viable, deterministic options (the gift is in the checkout order by construction):

1. **Product that inherently includes the gift** — the first-order product is a starter-kit/bundle whose fulfilment includes the whisk, and the subscription continues on the main product. Ancient Extracts already operates this pattern for Morning Magic (Starter Kit products 15077480857986 / 15349048213890 mapped into the programme; starter-kit checkout = cycle 1). Cheapest and fully deterministic if every Morning Magic / Evening Elixir subscription starts on such a product. To verify: the current Starter Kit's fulfilment content, and whether all MM/EE checkouts go through it.
2. **Storefront/cart rule** — the theme (or a Shopify Function / cart transform) adds the £0 "Morning Magic 1" marker line to the cart whenever an MM/EE subscription is present, so the checkout order carries the marker line like any renewal would. Deterministic, no race, reuses the marker convention the warehouse already reads; needs theme work (the Ancient Extracts theme project).
3. **Standing packing rule on Recharge's first-order tag** — Recharge tags first orders ("Subscription First Order"); "MM/EE first order ⇒ add whisk" as a warehouse rule. Zero tech, but relies on process rather than a marker line.

Recommendation: 1 where the starter kit already carries the whisk (confirm), otherwise 2. Our platform's role for INITIAL_CHECKOUT milestones is **record + verify only**: the milestone exists in the schedule (so the matrix is complete and gift history is coherent), the renewal planner never plans it, and a later read-only check can flag `FIRST_DELIVERY_GIFT_MISSING` when the first order lacks the expected line. Known limitation: CUSTOMER_PROGRAM cannot suppress a checkout-bundled whisk for a returning customer unless the storefront rule checks history — we state it, we do not pretend otherwise.

## 12. Phase 4 code that stays unchanged

`AutomationAction` model + `liveKey`/`ownerKey` + `transitionAction`, schedule maths (`computeSchedule`, `localMidnightUtc`), the DRY_RUN executor and its stored preview, Inngest planner/dry-run jobs and the sync-driven dispatch, automation mode control (LIVE refused), Upcoming + action detail UI, the shared population loader and lifetime computation, `evaluateJourneyEligibility`, `qualifyForRule` (fed a milestone), impact analysis by (programme, cycle), markers' placeholder semantics, connector (GET only).

## 13. What actually changes

Schema: 3 new models (`RewardSchedule`, `RewardScheduleMilestone`, `ProgramMilestoneMarker`), 2 enums, `SubscriptionProgram.rewardScheduleId`, `FulfillmentMarker.giftType/operationalNote`, `AutomationAction.rewardScheduleMilestoneId/programId`; `AutomationRule` kept legacy. Code: `resolveEffectiveMilestones()`; planner input (rules → effective milestones) and reconcile reasons (rule checks → milestone/binding/schedule checks: `SCHEDULE_NOT_READY`, `MILESTONE_INACTIVE`, `BINDING_MISSING`, …); dry-run/Upcoming show milestone + gift; schedule builder UI (schedule → milestones → programme assignments → per-programme marker bindings with readiness), rule pages become legacy; impact analysis gains a per-schedule readiness view; seed; tests.

## 14. Migration / backfill plan for the real Ancient Extracts configuration (additive only)

1. Additive migration (via `npm run db:diff:live` → hand-authored SQL → `npm run db:deploy`): new enums/tables/columns, CHECKs, FKs; no drops.
2. Seed the two schedules (DRAFT) for AE: A (2 WHISK, 3 CUP), B (1 WHISK INITIAL_CHECKOUT, 2 CUP, 3 SPOON), scopes CUSTOMER_PROGRAM (pending §4 confirmation).
3. Assign MM + EE → B. Bind MM × 2 → existing placeholder (giftType CUP). Archive the DRAFT rule with the migration activity row (§6).
4. Schedule A programmes do not exist yet: create them through the normal programme/mapping flow using the catalogue evidence below (proposal, approval first, no auto-mapping), then assign → A and bind markers as the real £0 variants are created.
5. Integrity check + fingerprint: journeys/cycles unchanged (config only). Planner on AE: still nothing plannable until real markers exist.

## 15. Tests required before proceeding

- Constraints: unique (schedule, cycle), unique (programme, cycle) binding, CHECK cycle 1 ⇔ INITIAL_CHECKOUT, scope required, cross-tenant isolation for the 3 new tenant models.
- Resolver: effective milestones + every readiness reason; gift mismatch; placeholder; schedule DRAFT.
- Planner: consumes effective milestones; INITIAL_CHECKOUT never planned; programmes sharing Schedule A keep separate lifetimes (Chaga whisk + Tremella whisk for the same customer under per-programme policy); Stuart regression under CUSTOMER_PROGRAM still holds; schedule swap → no duplicate action (keys); binding marker change → SUPERSEDED + new; schedule back to DRAFT → cancel `SCHEDULE_NOT_READY`; run-twice/concurrency/recalc idempotency re-run on the new path.
- Migration: AE rule → schedule conversion keeps every RULE activity row and the rule's legacy status.
- Impact analysis parity with the planner on the new path; dry-run preview shows milestone/gift.

## Ancient Extracts — reward configuration matrix (target state, with catalogue evidence)

Scope for all milestones below: **CUSTOMER_PROGRAM** (proposed; confirm). Delivery 1 entries are `INITIAL_CHECKOUT` (recorded, not planned). Markers listed are the *fulfilment-visible names* (real £0 variants still to be created); gift in brackets is the internal meaning.

**Schedule A — delivery 2 → Whisk, delivery 3 → Cup**

| Programme (to create) | Catalogue evidence (read-only, unmapped today) | Delivery 2 | Delivery 3 |
|---|---|---|---|
| Chaga | 8525211009319 "Chaga Mushroom Extract Powder" (variants Default/1/2/3 — legacy Default → numbered = same programme) · 16 subs (5 active) · 32 orders | "Chaga 2" (WHISK) | "Chaga 3" (CUP) |
| Cordyceps | 8525213040935 (Default/1/3) · 8 subs (2 active) · 20 orders | "Cordyceps 2" (WHISK) | "Cordyceps 3" (CUP) |
| Lion's Mane | 8525215334695 (Default/1/2/3) · 21 subs (7 active) · 60 orders | "Lion's Mane 2" (WHISK) | "Lion's Mane 3" (CUP) |
| Reishi | 8525215007015 (Default/1/3) · 10 subs (3 active) · 19 orders | "Reishi 2" (WHISK) | "Reishi 3" (CUP) |
| Tremella | 9569100300583 (Default/1/2/3) · 25 subs (11 active) · 64 orders | "Tremella 2" (WHISK) | "Tremella 3" (CUP) |
| Ceremonial Grade Matcha | **two product ids, continuous**: 14920527020418 (Jan–May 2026) → 15259499266434 (Mar 2026→); subscriptions 767767988 and 770859002 have orders under both → one programme, both ids mapped | "Matcha 2" (WHISK) | "Matcha 3" (CUP) |
| Hojicha | **no product in the imported catalogue** (no subscriptions/orders yet) — programme created when the product appears | "Hojicha 2" (WHISK) | "Hojicha 3" (CUP) |
| Butterfly Pea | 15191093936514 · 8 subs (5 active) · 11 orders (the "Ritual Grade Coloured Matcha Powders (60g)" 15171838017922 has a Butterfly Pea variant — decide: exclude as bundle or map that variant) | "Butterfly Pea 2" (WHISK) | "Butterfly Pea 3" (CUP) |
| Hibiscus | 15191097115010 · 2 subs (1 active) · 3 orders | "Hibiscus 2" (WHISK) | "Hibiscus 3" (CUP) |
| Ube | 15191096623490 "Ube Powder (Purple Yam)" · 6 subs (3 active) · 6 orders | "Ube 2" (WHISK) | "Ube 3" (CUP) |
| Pitaya Dragon Fruit | 15191096328578 · 3 subs (2 active) · 5 orders | "Pitaya 2" (WHISK) | "Pitaya 3" (CUP) |
| Soursop | **two product ids, continuous**: 15036118761858 "(60g)" (Sep 2025–May 2026, Default/1/2) → 15259503165826 (Apr 2026→); subscriptions 719633064 and 770859003 span both → one programme, both ids mapped | "Soursop 2" (WHISK) | "Soursop 3" (CUP) |

Stay **unmapped** unless explicitly approved: all Pairs / Stacks / Collection Boxes / "Box bundle" / "Indulgent Pair - Matcha & Ube" / "Ritual Grade Matcha Bundle" / "Am & Pm Ritual" / "Digestive+ Stack" (one such subscription 766625952 moved Beauty Pair → Tremella: that is a programme change into Tremella, handled by lifecycle, not by mapping the pair). Pets products, Turkey Tail, Shilajit Powder: outside both schedules for now.

**Schedule B — delivery 1 → Whisk (INITIAL_CHECKOUT), delivery 2 → Cup, delivery 3 → Spoon**

| Programme (live, validated mapping untouched) | Delivery 1 | Delivery 2 | Delivery 3 |
|---|---|---|---|
| Morning Magic Powder (8848660857127 + starter kits 15077480857986, 15349048213890) | Whisk — via checkout product/cart rule (§11), not planned | "Morning Magic 2" (CUP) — currently bound to the non-executable placeholder | "Morning Magic 3" (SPOON) |
| Evening Elixir Mushroom Cacao (15172321051010) | Whisk — via checkout (§11) | "Evening Elixir 2" (CUP) | "Evening Elixir 3" (SPOON) |

Existing live programmes **not** in either schedule and untouched: Shilajit Resin, Ceremonial Cacao Chunks (no milestones defined yet).

## Decisions needed before implementation

1. Confirm CUSTOMER_PROGRAM for all Schedule A and Evening Elixir milestones.
2. Whisk once per *programme* (V1 as framed) or once per *customer across the Schedule A family* (`CUSTOMER_SCHEDULE`)?
3. Delivery-1 mechanism: starter kit inherently including the whisk, or storefront cart rule (theme work) — your call with the fulfilment/theme side; we record + verify only.
4. Matcha and Soursop: approve mapping both continuous product ids into one programme each; Butterfly Pea variant of the coloured-powders product: exclude or map.


## External fulfilment (revised Phase 4c — implemented)

There are no programme-specific marker products. Each physical **RewardItem** (Whisk, Cup, Spoon) binds once per store to its **existing** Shopify variant (`RewardItemExternalBinding`; canonical identity = Shopify variant id), and every schedule milestone that awards the item resolves to that same variant. Shopify access is read-only (client-credentials auth, read_products); binding is an explicit search → pick → confirm flow with read-only verification. The future Recharge one-time references the bound variant at price 0.00 with the reward name as the line title — "Morning Magic" + "Cup" on the order is what fulfilment needs. `rechargeCompatibility` stays UNVERIFIED until the Phase 6 controlled test. See ARCHITECTURE §26.

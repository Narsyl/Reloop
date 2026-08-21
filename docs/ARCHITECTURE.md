# Subscription Operations Platform — Architecture Proposal

**Status:** proposal for review, 21 Aug 2026. Nothing below is implemented yet beyond the Recharge proof-of-concept.
**Scope of this document:** task 55 of the brief — POC audit, target folder architecture, Prisma schema, relationships & constraints, POC file fates, phased checklist, open decisions.

---

## 1. Audit of the existing `ancient-subscriptions` codebase

What exists today (470 lines, created 21 Aug 2026):

| File | What it does | Verdict |
|---|---|---|
| `lib/recharge.ts` | Single `rechargeFetch()` against `api.rechargeapps.com`; token from `process.env`; throws on non-2xx. | **Refactor → `lib/integrations/recharge/client.ts`.** The shape is right (one choke-point for all Recharge calls). What must change: token comes from the decrypted `Integration` record, not env; add timeout, retry with backoff on 429/5xx/network, rate-limit header awareness, correlation ID, structured logging, Zod-validated responses. Module-level `throw` on missing env goes away. |
| `app/api/recharge/subscription/route.ts` | GET by `subscriptionId`, returns a flattened subscription. | **Retire the route; keep the mapping.** The field mapping (`product_title → productTitle`, `external_variant_id.ecommerce → externalVariantId`, etc.) becomes `lib/integrations/recharge/mapper.ts`. The route itself is unauthenticated and unscoped, so it cannot survive into a multi-tenant app. |
| `app/api/recharge/add-cycle-marker/route.ts` | Loads subscription, checks active + next charge date, `POST /onetimes` on the exact `next_charge_scheduled_at`. | **Refactor → the `ADD_FULFILLMENT_MARKER` executor** (`lib/domain/actions/executors/add-fulfillment-marker.ts`). Steps 1–3 of this route are ~60% of the Phase 5 executor. Missing: `AutomationAction` record first, idempotency, "marker already attached?" check against existing one-times, persisting the one-time ID, activity log, exception on failure. The one-time payload shape is proven and is kept verbatim in `onetimes.ts`. |
| `app/page.tsx` | Client test UI: load subscription → "Add Morning Magic 2". | **Delete** once the real UI exists. Its function is replaced by the subscription detail page's "Manually add marker" action (with confirmation dialog). Until then it stays, local-only. |
| `.env.local` | `RECHARGE_API_TOKEN`, `MORNING_MAGIC_2_*` | **Restructure.** Per-merchant credentials move into the encrypted `Integration` row. The `MORNING_MAGIC_2_*` variables are exactly the hard-coding the brief forbids — they become a seeded `FulfillmentMarker` in the demo org. Env keeps only platform-level secrets (see §8). |
| `next.config.ts` | `reactCompiler`, `turbopack.root` pinned | **Retain.** |
| `app/layout.tsx`, `globals.css`, `public/*.svg` | create-next-app defaults (Geist font, Next/Vercel logos) | **Replace** in Phase 1 with the design system shell. |

Two things the POC proved that we keep as architectural facts: (1) `next_charge_scheduled_at` on the one-time — not `add_to_next_charge` — is how we pin a marker to the *right* subscription's charge; (2) the Recharge → Shopify → Royal Mail chain needs no further integration from us.

**Repository note.** The project currently has no git repository of its own — the nearest git root is `C:\Users\facti` (home directory, no commits, thousands of unrelated staged files). Phase 1 should `git init` inside the project folder so the platform has clean history. Not doing this until confirmed.

---

## 2. Architecture decisions (with recommendations)

These are the decisions that shape everything else. Each has a recommendation; §9 lists them again as a checklist to confirm.

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | Authentication library | **Better Auth** (email + password, DB sessions via Prisma adapter). We own `Organization` / `OrganizationMembership` tables ourselves — we do *not* use its organization plugin. | Native email/password with database sessions; Auth.js v5's credentials provider doesn't persist sessions to the DB well; Clerk would push orgs into a vendor. Explicit membership rows = the brief's tenancy model. |
| D2 | Job engine | **Postgres-backed `Job` table + Vercel Cron sweeper + `after()` for immediate best-effort processing.** Runner claims rows with `FOR UPDATE SKIP LOCKED`. | No new vendor; retries/backoff are our columns; replayable by design. Webhooks: store event → `200` → `after()` enqueues/processes → cron sweeps anything left in `RECEIVED`. Upgrade path to Inngest later is a single adapter swap. Note: per-minute cron needs Vercel Pro; Hobby is daily. |
| D3 | Current organisation | **Session-stored `activeOrganizationId`**, routes stay as in the brief (`/subscriptions`, `/rules`…). Switcher updates the session. | Keeps the brief's URLs; every server action/route handler resolves `currentOrg` from the session and scopes all queries by it. |
| D4 | What counts as a "successful cycle" | A Recharge **order with status `success`** (i.e. charge succeeded and the order was sent to Shopify) containing the subscription's line item. The **initial checkout order is cycle 1.** Counted once per `(journey, externalOrderId)`. | Recharge has no shipping signal; a processed order is the event that produces the shipment. The brief's example ("Cycle 1 just shipped → next cycle 2 → plan marker") implies checkout = cycle 1. |
| D5 | Idempotency key for actions | **`(journeyId, targetCycle, fulfillmentMarkerId)`** while the action is live — stronger than `(journey, cycle, rule)`. | The physical invariant is "never ship the same marker twice for the same delivery". The marker-based key also covers manual additions (no rule) and two rules mapping to the same marker. Implemented as a nullable unique `liveKey` column (Prisma-native, no partial indexes). |
| D6 | When a planned marker is attached in Recharge | **Immediately when planned** (Phase 5). A per-org `actionLeadDays` setting can be added later if attaching weeks early proves undesirable. | Simplest correct behaviour; reconciliation (Phase 8) handles date moves. |
| D7 | Product granularity | Split the brief's `Product` into **`Product` + `ProductVariant`**. Rules target a product (any variant) or a specific variant; markers and subscriptions point at a variant. | Matches the brief's rule fields (`productId`, `variantId nullable`) and Recharge's product/variant reality. One-time creation requires an exact variant. |
| D8 | Per-cycle records | Add **`JourneyCycle`** rows (one per successful order per journey) rather than only an integer counter. | Gives idempotent counting (unique on order), the timeline UI ("Cycle 1 ✓ 24 Aug"), and auditable backfill. `successfulCycles` stays as the denormalised counter. |
| D9 | Package / folder name | Keep the folder for now; rename the `package.json` name to something brand-neutral when Phase 1 starts. | The brief: nothing AE-specific in the core. Folder rename is cosmetic and can happen with `git init`. |
| D10 | Recharge plan dependency | **Hard rule: the platform must not depend on any Recharge premium (Plus-only) API resource.** See §2a. | Merchant A may be on Recharge Starter, merchant B on Plus. Everything V1 needs is on the standard Admin REST API + webhooks. |

---

## 2a. Recharge plan independence (hard rule)

**Our platform must not depend on any Recharge premium API resource.** Confirmed against Recharge's current docs: the Events API (`GET /events`) is Plus-only; credit accounts / adjustments / reward credits are tied to the paid Credits/Retain offering; customer sessions and the Storefront API/JS SDK are restricted to higher plans. None of these are needed for the product we are building: *merchant → our platform → our server → Recharge Admin REST API*.

### Token permissions requested for V1 (least privilege)

| Permission | Access | Why |
|---|---|---|
| Customers | View | Names/emails for dashboard and search |
| Orders | View | Historical successful orders (cycle backfill) + `order/*` webhooks |
| Products | View | Product / variant / SKU mapping |
| Store information | View | Test connection, store identity |
| Subscriptions | **View + manage** | Read subscriptions; create/update/delete one-times — *the* permission behind the proven feature |
| Plans | View (optional) | Subscription-plan / frequency display later |

Explicitly **not** requested: credit accounts, credit adjustments, credit summary, reward credits, Recharge Rewards, Free Gifts API, Events API, customer sessions / Storefront, payment-method modification, payment processing, discounts (initially).

### Webhooks do not need the Events API

Recharge webhooks are permissioned by the *underlying resource*: `order/*` topics need `read_orders`; `subscription/*` and `onetime/*` topics need `read_subscriptions`. They are registered through `POST /webhooks` and do not require `read_events`. So:

```text
Recharge Events API (Plus)   ❌ unavailable, not used
Recharge webhooks            ✅ order/* subscription/* onetime/*
        ↓
IntegrationEvent (our DB, permanent)
        ↓
ActivityLog / AutomationAction — our own history
```

**`IntegrationEvent` represents webhook deliveries received directly by our platform. It is never populated from Recharge's Events API.** Our database is the system of record for event history; we are not dependent on Recharge's short event-retention window.

### Connector surface for V1

```text
Recharge Connector
├── Store          read
├── Customers      read
├── Products       read (products + variants)
├── Orders         read
├── Subscriptions  read, manage
├── One-times      read, create, update, delete
└── Webhooks       register/list/delete: order/*, subscription/*, onetime/*
```

`charges`, `plans`, `discounts`, `credits`, `events`, `customer sessions` are **not** exposed by the connector in V1. Adding a resource later is a new module plus a capability probe — never a dependency of the core.

### Domain is ours, not Recharge's

Domain names never mirror Recharge premium concepts: it is `AutomationRule` not `RechargeReward`, `FulfillmentMarker` not `RechargeGift`, the Activity page reads `IntegrationEvent` / `ActivityLog` / `AutomationAction`, never `/events`. If we ever add loyalty accounting it is our own `RewardLedger`, with Recharge Credits as at most an optional destination.

### Capability check on connect

When a Recharge integration is connected (and on each sync), the connector probes each resource it uses and stores the result in `Integration.capabilitiesJson` / `capabilitiesCheckedAt`. The Integrations page shows:

```text
Recharge — Ancient Extracts
All features required by Subscription Ops are available.

● Customers       available
● Products        available
● Orders          available
● Subscriptions   read / write
● One-times       available
● Webhooks        available

Optional Recharge features
○ Credits            unavailable on current Recharge plan
○ Events API         unavailable on current Recharge plan
○ Storefront sessions unavailable on current Recharge plan
```

A missing *required* capability blocks activation of rules and raises a CRITICAL exception; missing optional capabilities are informational only. Capabilities are detected per integration, never assumed.

---

## 3. Target folder architecture

```text
ancient-subscriptions/
├── app/
│   ├── (auth)/
│   │   ├── login/page.tsx
│   │   ├── signup/page.tsx
│   │   └── layout.tsx                      # centred auth layout, no sidebar
│   ├── (app)/                              # authenticated + org-scoped shell
│   │   ├── layout.tsx                      # sidebar, org switcher, requires session + active org
│   │   ├── page.tsx                        # Overview (dashboard)
│   │   ├── subscriptions/
│   │   │   ├── page.tsx                    # list (server-side paging/filters)
│   │   │   └── [id]/page.tsx               # detail: journey timeline, actions, activity, external refs
│   │   ├── upcoming/page.tsx
│   │   ├── rules/
│   │   │   ├── page.tsx
│   │   │   ├── new/page.tsx                # 3-step builder + preview
│   │   │   └── [id]/page.tsx
│   │   ├── products/page.tsx               # tabs: Subscription Products | Fulfilment Markers
│   │   ├── activity/page.tsx
│   │   ├── exceptions/page.tsx
│   │   ├── settings/
│   │   │   ├── general/page.tsx
│   │   │   ├── team/page.tsx
│   │   │   └── integrations/page.tsx       # + recharge connect flow
│   │   └── onboarding/page.tsx             # create first org / connect first integration
│   ├── api/
│   │   ├── auth/[...all]/route.ts          # Better Auth handler
│   │   ├── webhooks/recharge/[integrationId]/route.ts
│   │   └── jobs/run/route.ts               # Vercel Cron target (bearer-protected)
│   ├── layout.tsx
│   └── globals.css                         # design tokens
│
├── components/
│   ├── ui/                                 # primitives: Button, Input, Select, Dialog, Badge, Table, Tabs, Tooltip, Skeleton…
│   ├── layout/                             # Sidebar, PageHeader, OrgSwitcher, Topbar
│   ├── data/                               # DataTable, FilterBar, Pagination, EmptyState, Metric
│   ├── status/                             # StatusBadge (single source of status → colour), IntegrationStatus, ExceptionBanner
│   ├── timeline/                           # Timeline, ActivityItem, JourneyTimeline
│   └── domain/                             # RuleSummary, RulePreview, MarkerCard, SubscriptionHeader, DetailRow, ConfirmationDialog
│
├── lib/
│   ├── auth/
│   │   ├── auth.ts                         # Better Auth instance (Prisma adapter)
│   │   ├── session.ts                      # getSession(), requireUser()
│   │   └── tenancy.ts                      # requireOrg(), requireRole(), OrgContext type
│   ├── db/
│   │   └── prisma.ts                       # singleton client
│   ├── crypto/
│   │   └── credentials.ts                  # AES-256-GCM encrypt/decrypt, versioned "v1:" prefix
│   ├── integrations/
│   │   ├── types.ts                        # provider-agnostic connector interface + domain DTOs
│   │   ├── registry.ts                     # provider → connector factory
│   │   └── recharge/
│   │       ├── client.ts                   # fetch wrapper: auth, version, timeout, retry, rate-limit, correlation id
│   │       ├── schemas.ts                  # Zod schemas for every Recharge response we rely on
│   │       ├── types.ts                    # inferred TS types
│   │       ├── mapper.ts                   # Recharge → internal DTOs (the only place that knows field names)
│   │       ├── store.ts                    # GET /store (test connection)
│   │       ├── capabilities.ts             # probe required/optional resources → capability map (§2a)
│   │       ├── subscriptions.ts
│   │       ├── customers.ts
│   │       ├── products.ts                 # products + variants
│   │       ├── orders.ts
│   │       ├── onetimes.ts                 # list / get / create / update / delete one-time
│   │       └── webhooks.ts                 # register/list/delete order/* subscription/* onetime/*; HMAC verification
│   │       # deliberately absent in V1: charges, plans, discounts, credits, events, customer sessions
│   ├── domain/                             # business logic; talks to Prisma + connectors, never to HTTP
│   │   ├── organizations/
│   │   ├── integrations/                   # connect, test, disconnect, sync orchestration
│   │   ├── sync/                           # import customers/products/subscriptions/orders (read-only)
│   │   ├── subscriptions/
│   │   ├── journeys/                       # start/end journey, record cycle, swap handling
│   │   ├── rules/                          # CRUD, validation, activation preview, matching (pure)
│   │   ├── actions/
│   │   │   ├── plan.ts                     # create PLANNED action with liveKey
│   │   │   ├── execute.ts                  # state machine + retry policy
│   │   │   ├── reconcile.ts                # skip/move/cancel/swap reconciliation
│   │   │   └── executors/add-fulfillment-marker.ts
│   │   ├── events/                         # inbox: store, dedupe, dispatch by topic
│   │   ├── exceptions/
│   │   └── activity/                       # logActivity() helper
│   ├── jobs/
│   │   ├── queue.ts                        # enqueue(), claim(), complete(), fail() (SKIP LOCKED)
│   │   ├── runner.ts                       # invoked by /api/jobs/run; handler registry
│   │   └── handlers/                       # process-event, execute-action, reconcile-action, daily-reconcile, initial-sync
│   ├── logging/
│   │   └── logger.ts                       # structured logs with org/integration/subscription/action/event ids; redaction
│   └── validation/                         # shared Zod schemas for forms/server actions
│
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts                             # "Ancient Extracts Demo" org + realistic data
│
├── tests/
│   ├── unit/                               # rule matching, journey maths, idempotency, crypto, mapper
│   ├── integration/                        # mocked connector: order → cycle → rule → action
│   └── webhooks/                           # signature valid/invalid, duplicate, out-of-order, malformed
│
├── docs/
│   └── ARCHITECTURE.md                     # this file
├── .env.example
└── vercel.json                             # cron schedule for /api/jobs/run
```

Boundary rules:
- `app/` never imports from `lib/integrations/recharge/*` directly — only from `lib/domain/*`.
- `lib/domain/*` never sees a Recharge response object; it receives mapped DTOs from the connector.
- Every domain function takes an `OrgContext` (org id + user/role) as its first argument; every Prisma query includes `organizationId`.
- Only `lib/integrations/recharge/client.ts` performs HTTP to Recharge.

---

## 4. Prisma schema (proposed)

Complete and ready to drop into `prisma/schema.prisma`. Models marked *(added)* are not in the brief's list of 13 but are needed to meet its requirements; §5 explains each.

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ───────────────────────────── Identity & tenancy ─────────────────────────────

model User {
  id            String   @id @default(cuid())
  email         String   @unique
  emailVerified Boolean  @default(false)
  name          String?
  image         String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  memberships OrganizationMembership[]
  sessions    Session[]
  accounts    Account[]
}

// Session / Account / Verification are managed by Better Auth (added)
model Session {
  id                   String   @id @default(cuid())
  userId               String
  token                String   @unique
  expiresAt            DateTime
  ipAddress            String?
  userAgent            String?
  activeOrganizationId String?  // D3: current org lives on the session
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
}

model Account {
  id                    String    @id @default(cuid())
  userId                String
  accountId             String
  providerId            String
  accessToken           String?
  refreshToken          String?
  idToken               String?
  accessTokenExpiresAt  DateTime?
  refreshTokenExpiresAt DateTime?
  scope                 String?
  password              String?   // hashed, credential provider
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([providerId, accountId])
  @@index([userId])
}

model Verification {
  id         String   @id @default(cuid())
  identifier String
  value      String
  expiresAt  DateTime
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  @@index([identifier])
}

model Organization {
  id        String   @id @default(cuid())
  name      String
  slug      String   @unique
  timezone  String   @default("Europe/London")
  currency  String   @default("GBP")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  memberships        OrganizationMembership[]
  integrations       Integration[]
  customers          Customer[]
  products           Product[]
  productVariants    ProductVariant[]
  fulfillmentMarkers FulfillmentMarker[]
  subscriptions      Subscription[]
  journeys           SubscriptionJourney[]
  journeyCycles      JourneyCycle[]
  rules              AutomationRule[]
  actions            AutomationAction[]
  events             IntegrationEvent[]
  exceptions         Exception[]
  activityLogs       ActivityLog[]
  jobs               Job[]
}

enum OrganizationRole {
  OWNER
  ADMIN
  OPERATOR
  VIEWER
}

model OrganizationMembership {
  id             String           @id @default(cuid())
  organizationId String
  userId         String
  role           OrganizationRole @default(VIEWER)
  createdAt      DateTime         @default(now())
  updatedAt      DateTime         @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  user         User         @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([organizationId, userId])
  @@index([userId])
}

// ───────────────────────────── Integrations ─────────────────────────────

enum IntegrationProvider {
  RECHARGE
}

enum IntegrationStatus {
  CONNECTED
  ERROR
  DISCONNECTED
}

model Integration {
  id                   String              @id @default(cuid())
  organizationId       String
  provider             IntegrationProvider
  status               IntegrationStatus   @default(CONNECTED)
  externalStoreId      String              // Recharge store id / domain from GET /store
  displayName          String
  encryptedCredentials String              // "v1:<iv>:<tag>:<ciphertext>" — AES-256-GCM, see lib/crypto
  settingsJson         Json?               // webhook registration state, api version, etc.
  capabilitiesJson     Json?               // §2a probe result: { customers: "available", subscriptions: "read_write", events: "unavailable", … }
  capabilitiesCheckedAt DateTime?
  lastSuccessfulSyncAt DateTime?
  lastErrorAt          DateTime?
  lastErrorMessage     String?
  createdAt            DateTime            @default(now())
  updatedAt            DateTime            @updatedAt

  organization  Organization       @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  customers     Customer[]
  products      Product[]
  subscriptions Subscription[]
  actions       AutomationAction[]
  events        IntegrationEvent[]
  exceptions    Exception[]

  @@unique([organizationId, provider, externalStoreId])
  @@index([organizationId])
}

// ───────────────────────────── Catalogue ─────────────────────────────

// (added) customers needed for display + search
model Customer {
  id                 String    @id @default(cuid())
  organizationId     String
  integrationId      String
  externalCustomerId String
  email              String?
  firstName          String?
  lastName           String?
  lastSyncedAt       DateTime?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt

  organization  Organization   @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  integration   Integration    @relation(fields: [integrationId], references: [id], onDelete: Cascade)
  subscriptions Subscription[]

  @@unique([integrationId, externalCustomerId])
  @@index([organizationId, email])
  @@index([organizationId, lastName, firstName])
}

enum ProductType {
  SUBSCRIPTION_PRODUCT
  FULFILMENT_MARKER
  GIFT_PRODUCT
}

model Product {
  id                String      @id @default(cuid())
  organizationId    String
  integrationId     String
  externalProductId String
  title             String
  type              ProductType @default(SUBSCRIPTION_PRODUCT)
  active            Boolean     @default(true)
  lastSyncedAt      DateTime?
  createdAt         DateTime    @default(now())
  updatedAt         DateTime    @updatedAt

  organization  Organization          @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  integration   Integration           @relation(fields: [integrationId], references: [id], onDelete: Cascade)
  variants      ProductVariant[]
  subscriptions Subscription[]
  journeys      SubscriptionJourney[]
  rules         AutomationRule[]

  @@unique([integrationId, externalProductId])
  @@index([organizationId, type, active])
}

// (added) D7 — variant granularity
model ProductVariant {
  id                String   @id @default(cuid())
  organizationId    String
  productId         String
  externalVariantId String
  title             String
  sku               String?
  price             Decimal? @db.Decimal(10, 2)
  active            Boolean  @default(true)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  organization Organization        @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  product      Product             @relation(fields: [productId], references: [id], onDelete: Cascade)
  markers      FulfillmentMarker[]
  subscriptions Subscription[]
  rules        AutomationRule[]

  @@unique([productId, externalVariantId])
  @@index([organizationId, sku])
}

model FulfillmentMarker {
  id             String   @id @default(cuid())
  organizationId String
  name           String   // internal name, e.g. "Morning Magic Cycle 2"
  description    String?  // internal operational note, e.g. "Fulfilment team adds free whisk"
  variantId      String   // the £0 product variant inserted into the shipment
  active         Boolean  @default(true)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  organization Organization       @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  variant      ProductVariant     @relation(fields: [variantId], references: [id], onDelete: Restrict)
  rules        AutomationRule[]
  actions      AutomationAction[]

  @@unique([organizationId, name])
  @@index([organizationId, active])
}

// ───────────────────────────── Subscriptions & journeys ─────────────────────────────

enum SubscriptionStatus {
  ACTIVE
  CANCELLED
  EXPIRED
  PAUSED    // Recharge has no native "paused"; we derive it from status + next_charge null
  UNKNOWN
}

model Subscription {
  id                     String             @id @default(cuid())
  organizationId         String
  integrationId          String
  customerId             String?
  externalSubscriptionId String
  externalCustomerId     String
  externalAddressId      String
  status                 SubscriptionStatus @default(UNKNOWN)
  externalStatus         String?            // raw provider status for display/debug

  productId              String?            // null when product not yet mapped → Exception PRODUCT_MAPPING_MISSING
  variantId              String?
  externalProductId      String
  externalVariantId      String
  productTitleSnapshot   String
  variantTitleSnapshot   String?
  skuSnapshot            String?

  quantity               Int                @default(1)
  price                  Decimal?           @db.Decimal(10, 2)
  intervalUnit           String?            // day | week | month
  intervalFrequency      Int?
  nextChargeAt           DateTime?
  externalCreatedAt      DateTime?
  cancelledAt            DateTime?

  currentJourneyId       String?            @unique  // exactly one current journey (D8)
  lastSyncedAt           DateTime?
  createdAt              DateTime           @default(now())
  updatedAt              DateTime           @updatedAt

  organization   Organization          @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  integration    Integration           @relation(fields: [integrationId], references: [id], onDelete: Cascade)
  customer       Customer?             @relation(fields: [customerId], references: [id], onDelete: SetNull)
  product        Product?              @relation(fields: [productId], references: [id], onDelete: SetNull)
  variant        ProductVariant?       @relation(fields: [variantId], references: [id], onDelete: SetNull)
  currentJourney SubscriptionJourney?  @relation("CurrentJourney", fields: [currentJourneyId], references: [id], onDelete: SetNull)
  journeys       SubscriptionJourney[] @relation("SubscriptionJourneys")
  actions        AutomationAction[]
  exceptions     Exception[]

  @@unique([integrationId, externalSubscriptionId])
  @@index([organizationId, status])
  @@index([organizationId, productId])
  @@index([organizationId, nextChargeAt])
  @@index([customerId])
}

enum JourneyEndReason {
  PRODUCT_SWAP
  CANCELLED
  EXPIRED
  MANUAL
}

model SubscriptionJourney {
  id               String            @id @default(cuid())
  organizationId   String
  subscriptionId   String
  productId        String?           // the product this journey tracks (null if unmapped)
  externalProductId String
  externalVariantId String
  sequence         Int               // 1, 2, 3… per subscription
  startedAt        DateTime
  endedAt          DateTime?
  endReason        JourneyEndReason?
  successfulCycles Int               @default(0) // denormalised count of JourneyCycle rows
  createdAt        DateTime          @default(now())
  updatedAt        DateTime          @updatedAt

  organization   Organization       @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  subscription   Subscription       @relation("SubscriptionJourneys", fields: [subscriptionId], references: [id], onDelete: Cascade)
  product        Product?           @relation(fields: [productId], references: [id], onDelete: SetNull)
  currentOf      Subscription?      @relation("CurrentJourney")
  cycles         JourneyCycle[]
  actions        AutomationAction[]
  exceptions     Exception[]

  @@unique([subscriptionId, sequence])
  @@index([organizationId, productId])
}

enum CycleSource {
  WEBHOOK
  BACKFILL
  MANUAL
}

// (added) D8 — one row per successful order per journey
model JourneyCycle {
  id              String      @id @default(cuid())
  organizationId  String
  journeyId       String
  cycleNumber     Int
  externalOrderId String
  externalChargeId String?
  processedAt     DateTime
  source          CycleSource
  createdAt       DateTime    @default(now())

  organization Organization        @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  journey      SubscriptionJourney @relation(fields: [journeyId], references: [id], onDelete: Cascade)

  @@unique([journeyId, cycleNumber])
  @@unique([journeyId, externalOrderId])
  @@index([organizationId, processedAt])
}

// ───────────────────────────── Rules & actions ─────────────────────────────

enum RuleTriggerType {
  SUBSCRIPTION_CYCLE
}

enum RuleActionType {
  ADD_FULFILLMENT_MARKER
}

enum ExistingSubscriptionPolicy {
  FUTURE_ONLY       // only subscriptions reaching the milestone after activation
  INCLUDE_EXISTING  // backfill: existing subscriptions already before the target cycle are planned too
}

model AutomationRule {
  id                  String                     @id @default(cuid())
  organizationId      String
  name                String
  description         String?
  enabled             Boolean                    @default(false) // "Save as disabled" is the default path
  priority            Int                        @default(100)
  triggerType         RuleTriggerType            @default(SUBSCRIPTION_CYCLE)
  productId           String
  variantId           String?                    // null = any variant of the product
  cycleNumber         Int
  actionType          RuleActionType             @default(ADD_FULFILLMENT_MARKER)
  fulfillmentMarkerId String
  existingPolicy      ExistingSubscriptionPolicy @default(FUTURE_ONLY)
  activatedAt         DateTime?
  lastTriggeredAt     DateTime?
  createdById         String?
  createdAt           DateTime                   @default(now())
  updatedAt           DateTime                   @updatedAt

  organization      Organization       @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  product           Product            @relation(fields: [productId], references: [id], onDelete: Restrict)
  variant           ProductVariant?    @relation(fields: [variantId], references: [id], onDelete: Restrict)
  fulfillmentMarker FulfillmentMarker  @relation(fields: [fulfillmentMarkerId], references: [id], onDelete: Restrict)
  actions           AutomationAction[]
  exceptions        Exception[]

  @@unique([organizationId, name])
  @@index([organizationId, enabled, productId, cycleNumber])
}

enum ActionType {
  ADD_FULFILLMENT_MARKER
}

enum ActionSource {
  RULE
  MANUAL
  BACKFILL
}

enum ActionStatus {
  PLANNED
  EXECUTING
  SUCCEEDED
  FAILED
  CANCELLED
  SUPERSEDED
}

model AutomationAction {
  id                  String       @id @default(cuid())
  organizationId      String
  integrationId       String
  ruleId              String?      // null for MANUAL
  subscriptionId      String
  journeyId           String
  fulfillmentMarkerId String
  type                ActionType   @default(ADD_FULFILLMENT_MARKER)
  source              ActionSource @default(RULE)
  targetCycle         Int
  status              ActionStatus @default(PLANNED)

  // D5 idempotency: "<journeyId>:<targetCycle>:<fulfillmentMarkerId>" while status is
  // PLANNED / EXECUTING / SUCCEEDED / FAILED; set to NULL when CANCELLED / SUPERSEDED.
  liveKey             String?      @unique

  scheduledFor        DateTime?    // the subscription's next charge date we are targeting
  executedAt          DateTime?
  externalObjectType  String?      // "recharge_onetime"
  externalObjectId    String?      // Recharge one-time id
  externalChargeDate  DateTime?    // date the one-time is currently pinned to (for reconciliation)
  attemptCount        Int          @default(0)
  nextAttemptAt       DateTime?
  lastError           String?
  lastErrorAt         DateTime?
  cancelReason        String?
  createdById         String?      // user id for MANUAL
  createdAt           DateTime     @default(now())
  updatedAt           DateTime     @updatedAt

  organization      Organization        @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  integration       Integration         @relation(fields: [integrationId], references: [id], onDelete: Cascade)
  rule              AutomationRule?     @relation(fields: [ruleId], references: [id], onDelete: SetNull)
  subscription      Subscription        @relation(fields: [subscriptionId], references: [id], onDelete: Cascade)
  journey           SubscriptionJourney @relation(fields: [journeyId], references: [id], onDelete: Cascade)
  fulfillmentMarker FulfillmentMarker   @relation(fields: [fulfillmentMarkerId], references: [id], onDelete: Restrict)
  exceptions        Exception[]

  @@index([organizationId, status, scheduledFor])
  @@index([subscriptionId])
  @@index([status, nextAttemptAt])
}

// ───────────────────────────── Event inbox ─────────────────────────────

enum IntegrationEventStatus {
  RECEIVED
  PROCESSING
  PROCESSED
  FAILED
  IGNORED
}

model IntegrationEvent {
  id              String                 @id @default(cuid())
  organizationId  String
  integrationId   String
  provider        IntegrationProvider
  eventType       String                 // e.g. "order/processed"
  externalEventId String?                // provider event id if supplied
  dedupeKey       String                 // externalEventId, else sha256(topic + raw body)
  payloadJson     Json
  headersJson     Json?
  signatureValid  Boolean
  receivedAt      DateTime               @default(now())
  processedAt     DateTime?
  status          IntegrationEventStatus @default(RECEIVED)
  attemptCount    Int                    @default(0)
  lastError       String?

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  integration  Integration  @relation(fields: [integrationId], references: [id], onDelete: Cascade)

  @@unique([integrationId, dedupeKey])
  @@index([status, receivedAt])
  @@index([organizationId, receivedAt])
}

// ───────────────────────────── Exceptions & activity ─────────────────────────────

enum ExceptionSeverity {
  INFO
  WARNING
  CRITICAL
}

enum ExceptionStatus {
  OPEN
  RESOLVED
  IGNORED
}

model Exception {
  id             String            @id @default(cuid())
  organizationId String
  severity       ExceptionSeverity
  type           String            // e.g. MARKER_PRODUCT_MISSING, AUTH_FAILED, CHARGE_DATE_MISSING, MARKER_ALREADY_EXISTS, …
  title          String
  description    String
  status         ExceptionStatus   @default(OPEN)
  autoResolved   Boolean           @default(false)
  integrationId  String?
  subscriptionId String?
  journeyId      String?
  ruleId         String?
  actionId       String?
  metadataJson   Json?
  detectedAt     DateTime          @default(now())
  resolvedAt     DateTime?
  resolvedById   String?

  organization Organization         @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  integration  Integration?         @relation(fields: [integrationId], references: [id], onDelete: SetNull)
  subscription Subscription?        @relation(fields: [subscriptionId], references: [id], onDelete: SetNull)
  journey      SubscriptionJourney? @relation(fields: [journeyId], references: [id], onDelete: SetNull)
  rule         AutomationRule?      @relation(fields: [ruleId], references: [id], onDelete: SetNull)
  action       AutomationAction?    @relation(fields: [actionId], references: [id], onDelete: SetNull)

  @@index([organizationId, status, severity])
  @@index([organizationId, detectedAt])
}

enum ActorType {
  USER
  SYSTEM
  INTEGRATION
}

enum EntityType {
  ORGANIZATION
  USER
  INTEGRATION
  PRODUCT
  FULFILLMENT_MARKER
  SUBSCRIPTION
  JOURNEY
  RULE
  ACTION
  EXCEPTION
  EVENT
}

model ActivityLog {
  id             String     @id @default(cuid())
  organizationId String
  actorType      ActorType
  actorId        String?    // user id, integration id, or null for SYSTEM
  eventType      String     // e.g. RULE_CREATED, CYCLE_COMPLETED, MARKER_QUEUED, ACTION_FAILED
  entityType     EntityType
  entityId       String
  summary        String     // human sentence shown in Activity
  metadataJson   Json?
  createdAt      DateTime   @default(now())

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId, createdAt])
  @@index([entityType, entityId])
}

// ───────────────────────────── Jobs (added, D2) ─────────────────────────────

enum JobStatus {
  PENDING
  RUNNING
  SUCCEEDED
  FAILED
  DEAD
}

model Job {
  id             String    @id @default(cuid())
  organizationId String?   // null for platform-wide jobs
  type           String    // PROCESS_EVENT, EXECUTE_ACTION, RECONCILE_ACTION, INITIAL_SYNC, DAILY_RECONCILE
  payloadJson    Json
  dedupeKey      String?   @unique
  status         JobStatus @default(PENDING)
  runAt          DateTime  @default(now())
  attempts       Int       @default(0)
  maxAttempts    Int       @default(5)
  lockedAt       DateTime?
  lockedBy       String?
  lastError      String?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  organization Organization? @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([status, runAt])
}
```

---

## 5. Relationships and constraints, explained

**Tenancy spine.** `User → OrganizationMembership → Organization`. Users own nothing else. Every merchant table carries `organizationId` with `onDelete: Cascade` back to the org, so deleting an org removes its world and nothing leaks. `@@unique([organizationId, userId])` stops duplicate memberships; `role` is on the membership, not the user. Cross-tenant safety is enforced in `lib/auth/tenancy.ts` — every domain function receives an `OrgContext` and every query includes `organizationId`; tests in Phase 1 assert that a query for org A's subscription id under org B's context returns nothing.

**Integration.** One org may have many integrations (several Recharge stores, later other providers); `@@unique([organizationId, provider, externalStoreId])` prevents connecting the same store twice. Credentials live only in `encryptedCredentials` (AES-256-GCM, key from `CREDENTIAL_ENCRYPTION_KEY`, `v1:` prefix for future rotation); the API client secret — which Recharge uses to sign webhooks — lives in the same blob. The webhook URL embeds `integrationId`, so a payload is verified against *that* integration's secret and routed to *that* org without any lookup ambiguity.

**Customer / Product / ProductVariant.** All keyed by `(integrationId, external…Id)` — the provider's identity is unique *per store*, never globally. `ProductVariant` is the unit both one-times and subscriptions reference; `Product` is the unit rules usually target. `Product.type` lets the same catalogue entry be flagged as a marker product. `FulfillmentMarker.variantId` uses `onDelete: Restrict` — you cannot remove a variant that a marker depends on; the correct path is deactivating the marker.

**Subscription.** `@@unique([integrationId, externalSubscriptionId])` — our id is never the Recharge id. `productId/variantId` are nullable because an import must succeed even when a product hasn't been mapped yet; that case raises a `PRODUCT_MAPPING_MISSING` exception rather than dropping the subscription. Snapshots (`productTitleSnapshot` etc.) keep the list readable even if the mapping is missing or the product is later renamed.

**SubscriptionJourney — the cycle-tracking unit.** One subscription has an ordered list of journeys (`@@unique([subscriptionId, sequence])`). "Exactly one current journey" is enforced by `Subscription.currentJourneyId @unique` (a one-to-one back-reference) rather than a boolean, which Postgres can actually guarantee. A swap ends journey *n* (`endReason = PRODUCT_SWAP`) and starts journey *n+1* with `successfulCycles = 0`, in one transaction that also repoints `currentJourneyId`.

**JourneyCycle.** `@@unique([journeyId, externalOrderId])` is what makes cycle counting idempotent: a replayed `order/processed` webhook inserts nothing and increments nothing. `@@unique([journeyId, cycleNumber])` keeps numbering dense. Backfill and webhooks write the same rows (`source` distinguishes them), so the timeline is one query.

**AutomationRule.** Targets a `Product` (any variant) or a specific `ProductVariant`; `onDelete: Restrict` on product/variant/marker means you cannot delete something a rule depends on — disable or delete the rule first. `enabled` defaults to `false` ("Save as disabled"). `existingPolicy` is the switch §42 of the brief describes. Matching is a pure function of `(rule, journey.product/variant, nextCycle)` — no SQL in the matcher, so it is unit-testable.

**AutomationAction — the audit record and the idempotency gate.** `liveKey` is the `(journeyId, targetCycle, fulfillmentMarkerId)` composite, unique, and non-null only while the action is live (PLANNED/EXECUTING/SUCCEEDED/FAILED). Two concurrent webhook deliveries both trying to plan "cycle 2 → Morning Magic 2" for the same journey: the second insert hits the unique violation and is treated as "already planned". A cancelled/superseded action nulls its `liveKey`, so a later legitimate re-plan (e.g. after unskip) can create a fresh live action without losing the cancelled one's history. The state machine lives in one module (`lib/domain/actions/execute.ts`), and transitions that change `liveKey` happen in the same transaction as the status change. `externalObjectId` + `externalChargeDate` are what reconciliation compares against Recharge.

**IntegrationEvent.** `@@unique([integrationId, dedupeKey])` is the inbox's duplicate guard. The webhook route does exactly three things synchronously — verify HMAC, upsert the event, return 200 — then hands off. Processing sets `PROCESSING → PROCESSED/FAILED`; `FAILED` rows are retried by the cron sweeper with backoff, up to a limit, then raise an exception.

**Exception / ActivityLog.** Both reference the entities they concern with `onDelete: SetNull` so history survives deletions. `ActivityLog.(entityType, entityId)` index powers the per-subscription Activity tab; `(organizationId, createdAt)` powers the global Activity page.

**Job.** Platform queue; `dedupeKey @unique` (nullable) prevents enqueueing the same reconcile twice. Claimed with `SELECT … FOR UPDATE SKIP LOCKED`, so multiple concurrent cron invocations never double-run a job.

---

## 6. Core flows (as they will be built)

**Connect Recharge (Phase 2).** Form → server action `testIntegrationConnection()` → `store.get()` via a *temporary* client built from the submitted credentials → `capabilities.probe()` (required: customers, products, orders, subscriptions read/write, one-times, webhooks; optional: credits, events, storefront sessions — reported, never required) → show store identity + capability panel → only then `connectIntegration()` encrypts + saves (incl. `capabilitiesJson`) + writes `INTEGRATION_CONNECTED` activity → enqueue `INITIAL_SYNC` job. A missing required capability blocks the save with a clear message.

**Initial sync (Phases 2–3, read-only).** Page through customers, products, subscriptions, then for each subscription its successful orders → build journeys and `JourneyCycle` rows (`source = BACKFILL`). Never writes to Recharge.

**Successful order (Phase 6–7).**
```text
POST /api/webhooks/recharge/[integrationId]
  verify HMAC with integration's client secret → upsert IntegrationEvent (dedupeKey) → 200
  after(): enqueue PROCESS_EVENT
PROCESS_EVENT handler
  for each line item with a purchase_item/subscription id:
    find Subscription (integrationId + externalSubscriptionId)
    lock current journey (SELECT … FOR UPDATE on the journey row)
    confirm product matches journey → else end journey + start new (swap detected late)
    insert JourneyCycle (unique on order id → replay is a no-op)
    successfulCycles += 1 ; nextCycle = successfulCycles + 1
    for each enabled rule matching (product/variant, nextCycle):
      planAction({ journey, targetCycle: nextCycle, marker, scheduledFor: subscription.nextChargeAt })
         → insert with liveKey; unique violation = already planned
      enqueue EXECUTE_ACTION
    log activity: CYCLE_COMPLETED, MARKER_QUEUED
```

**Execute `ADD_FULFILLMENT_MARKER` (Phase 5).** Fresh `subscriptions.get()` → must be active with `nextChargeAt` → marker variant must exist in Recharge → list one-times for the address and check none already matches (variant + date) → `onetimes.create({ address_id, next_charge_scheduled_at: subscription.nextChargeAt, external_variant_id, price: "0.00", quantity: 1 })` → save `externalObjectId`, `externalChargeDate` → `SUCCEEDED` → activity. Any non-retriable problem → `FAILED` + `Exception`; retriable → `nextAttemptAt` with exponential backoff.

**Skip / reschedule / cancel / swap (Phase 8).** Each lifecycle event enqueues `RECONCILE_ACTION` for live actions on that subscription: re-fetch subscription and one-time, compare `externalChargeDate` to `nextChargeAt`; move the one-time (update `next_charge_scheduled_at`) or delete it; cancelled subscription → delete one-time, `CANCELLED` with reason; swap → end journey, new journey, cancel inappropriate actions. Every move is an activity entry; anything ambiguous is an exception instead of a guess.

---

## 7. Phased implementation checklist

Each phase ends with the brief's definition of done. Boxes are what I will tick off.

### Phase 1 — Foundation
- [ ] `git init` in the project folder; neutral package name; `.env.example`
- [ ] Install Prisma, Zod, Better Auth; Neon database; `prisma/schema.prisma` from §4; first migration
- [ ] `lib/crypto/credentials.ts` (AES-256-GCM) + unit tests
- [ ] Better Auth: signup / login / logout; session carries `activeOrganizationId`
- [ ] `lib/auth/tenancy.ts`: `requireUser()`, `requireOrg()`, `requireRole()`; tenant-isolation tests
- [ ] Onboarding: create organisation → OWNER membership → set active org
- [ ] Org switcher (session update)
- [ ] Design tokens + primitives: Button, Input, Select, Dialog, Badge, Table, Tabs, Skeleton, Toast; `StatusBadge` as the single status→colour map
- [ ] App shell: sidebar per §37, PageHeader, EmptyState, loading/error states
- [ ] Settings skeleton: general (name, timezone, currency), team (members + roles read-only), integrations (placeholder)
- [ ] `prisma/seed.ts`: "Ancient Extracts Demo" org, 20 customers, 30 subscriptions across 4 products, journeys, rules, actions, activity, one critical exception
- [ ] Placeholder pages for Overview / Subscriptions / Upcoming / Rules / Products / Activity / Exceptions rendering seed data
- **Done when:** you can sign up, create an org, and move through a polished, empty-state-aware shell.

### Phase 2 — Recharge connector (read-only)
- [ ] `lib/integrations/recharge/client.ts` (refactor of `lib/recharge.ts`): per-integration credentials, timeout, retry/backoff for 429/5xx/network, rate-limit headers, correlation id, redacting logger
- [ ] Zod `schemas.ts` + `mapper.ts` for store, customer, product/variant, subscription, order, one-time (no charges/plans/credits/events in V1)
- [ ] `store.ts`, `capabilities.ts`, `customers.ts`, `products.ts`, `subscriptions.ts`, `orders.ts`, `onetimes.ts` (read paths)
- [ ] Integrations page: connect form → **Test connection** → store identity + capability panel ("All features required by Subscription Ops are available" / required vs optional) → save (encrypted) → connected card with last-checked, Sync, Settings, Disconnect (with confirmation)
- [ ] Token-permission guidance shown in the connect form: Customers/Orders/Products/Store = view; Subscriptions = view + manage; nothing else
- [ ] `Job` queue + `/api/jobs/run` + `vercel.json` cron + `INITIAL_SYNC` handler
- [ ] Import customers, products/variants, subscriptions; integration status/error surfacing
- [ ] Delete POC routes; move one-time payload shape into `onetimes.ts`
- **Done when:** Ancient Extracts connects and its subscriptions appear in `/subscriptions`. No writes.

### Phase 3 — Subscription intelligence
- [ ] Historical order import per subscription → `SubscriptionJourney` + `JourneyCycle` (BACKFILL)
- [ ] Journey start/end/swap domain functions + unit tests
- [ ] Subscription list: server-side search/filter/pagination (customer, email, ext id, SKU, product, status)
- [ ] Subscription detail: header, journey timeline, current subscription, actions, activity, external references (collapsed)
- [ ] `PRODUCT_MAPPING_MISSING` exception path
- **Done when:** for any imported subscription we show product, current journey, successful cycles, next charge — and they match Recharge.

### Phase 4 — Rules
- [ ] Products page: Subscription Products | Fulfilment Markers tabs; create marker from a catalogue variant; operational note
- [ ] `AutomationRule` CRUD; 3-step builder + rule preview sentence; save disabled / save & activate (confirmation explains impact)
- [ ] Pure matcher `matchRules(rules, journey, nextCycle)` + unit tests (product match, product mismatch, variant-specific, disabled)
- [ ] Activation preview: count of existing journeys at `cycle-1` with an upcoming charge; `existingPolicy` choice
- **Done when:** "Morning Magic / cycle 2 → Morning Magic 2" exists, previews correctly, executes nothing.

### Phase 5 — Action engine
- [ ] `planAction()` with `liveKey` idempotency + concurrency test
- [ ] State machine `execute.ts`; retry policy (retriable vs terminal); backoff
- [ ] Executor `add-fulfillment-marker.ts` (refactor of POC route) incl. "already attached" check
- [ ] Manual "Add marker" on subscription detail (confirmation) → MANUAL action → execute
- [ ] Action history on detail page; Upcoming page; failure → Exception
- **Done when:** one qualifying AE test subscription gets its £0 marker on the exact renewal date via the platform, and doing it twice does nothing.

### Phase 6 — Webhooks
- [ ] `webhooks.ts`: register/list/delete `order/*`, `subscription/*`, `onetime/*` topics for an integration (permissioned via read_orders / read_subscriptions — no Events API); store registration state
- [ ] `POST /api/webhooks/recharge/[integrationId]`: HMAC verify, event upsert, fast 200, `after()` hand-off
- [ ] `PROCESS_EVENT` handler with topic dispatch; order/processed → cycle increment
- [ ] Tests: valid/invalid signature, duplicate, out-of-order, malformed
- **Done when:** a real renewal updates cycle state without any manual action.

### Phase 7 — Automatic fulfilment
- [ ] Wire cycle increment → rule match → `planAction` → `EXECUTE_ACTION`
- [ ] Per-integration "automation enabled" switch; enable only for AE test subscription(s) first
- **Done when:** the end-to-end chain runs unattended for the test subscription.

### Phase 8 — Reconciliation
- [ ] Lifecycle topics → `RECONCILE_ACTION`; move/delete/recreate one-time; cancel with reason; swap handling
- [ ] Daily integration reconciliation + near-term action verification jobs
- [ ] Missing-marker / orphan-one-time detection → exceptions (auto-resolved vs needs action)
- **Done when:** skipping, moving, cancelling and swapping the test subscription all leave Recharge and our records consistent, with every move logged.

### Phase 9 — Existing subscriber backfill
- [ ] Review screen listing affected existing journeys for a rule; bulk plan as BACKFILL actions; nothing written without explicit confirmation
- **Done when:** AE's existing Morning Magic subscribers are queued for cycle 2 markers after a reviewed, confirmed run.

---

## 8. Environment variables

```text
DATABASE_URL                 Neon connection string
BETTER_AUTH_SECRET           session signing
BETTER_AUTH_URL              app origin
CREDENTIAL_ENCRYPTION_KEY    32 bytes, base64 — AES-256-GCM for Integration.encryptedCredentials
CRON_SECRET                  bearer token Vercel Cron sends to /api/jobs/run
RECHARGE_API_VERSION         default 2021-11 (can move to Integration.settingsJson)
```
Gone: `RECHARGE_API_TOKEN`, `MORNING_MAGIC_2_*` (credentials → encrypted Integration row; marker → seeded `FulfillmentMarker`). Optionally `SEED_RECHARGE_API_TOKEN` for local seeding of the demo integration only.

---

## 9. Decisions to confirm before Phase 1 starts

1. **D1** Better Auth for authentication — or do you prefer Auth.js / Clerk?
2. **D2** Postgres job table + Vercel Cron (needs Pro for per-minute) — or Inngest from day one?
3. **D4** Checkout order counts as cycle 1 (so "cycle 2" = first renewal).
4. **D5** Idempotency on `(journey, cycle, marker)` rather than `(journey, cycle, rule)`.
5. **D6** Markers attached to Recharge immediately when planned (no lead-time setting yet).
6. **D7/D8** Schema additions: `ProductVariant`, `JourneyCycle`, `Customer`, `Job`, auth tables.
7. **Repo** `git init` inside `ancient-subscriptions/` (it currently sits under a home-directory repo with no commits) and rename the package to something brand-neutral.
8. **D10** *(confirmed 21 Aug 2026)* No dependency on Recharge premium resources; V1 token = Customers/Orders/Products/Store view + Subscriptions view & manage; `IntegrationEvent` = webhook deliveries only; capability check on connect.

Reply with any changes, or "go" to start Phase 1 exactly as written.

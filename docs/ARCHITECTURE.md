# Reloop — Subscription Operations Platform
## Architecture review & foundation proposal (v3)

**Status:** review for sign-off, 21 Aug 2026. No code has been written against this document yet.
**Supersedes:** v2 (same file, git history). Structured to answer points 1–20 of the brief in order.
**Repo:** https://github.com/Narsyl/Reloop

> The one-sentence product: *"Customer is on successful delivery cycle X of subscription product Y, therefore perform operational action Z on the next shipment."* Everything below exists to make that sentence true, auditable, and impossible to execute twice.

---

## 1–2. Audit of the existing project and what to keep

The project is a fresh Next.js 16 scaffold plus ~470 lines of proof-of-concept written on 21 Aug 2026. The POC proved *our server → Recharge → exact subscription → £0 one-time on the exact renewal date*. That proof is valuable; the code shape is not the product.

| File | What it does today | Verdict | Why |
|---|---|---|---|
| `lib/recharge.ts` | `rechargeFetch()` — one fetch wrapper, token from env, throws on non-2xx | **Refactor** → `lib/integrations/recharge/client.ts` | Right idea (single choke-point). Wrong in every detail that matters at scale: env token (must be per-integration, decrypted at call time), no timeout, no retry classification, no rate-limit handling, no correlation id, `console.error` logs raw response bodies (could contain PII), module-level `throw` on missing env. ~20% survives. |
| `app/api/recharge/subscription/route.ts` | GET by `subscriptionId`, flattens fields | **Delete the route; keep the mapping** → `mapper.ts` | Unauthenticated, unscoped, exposes a tenant-free read. The field mapping (`external_variant_id.ecommerce → externalVariantId`, etc.) is exactly what the connector's mapper does. |
| `app/api/recharge/add-cycle-marker/route.ts` | Load sub → check active + `next_charge_scheduled_at` → `POST /onetimes` on that date | **Refactor** → `lib/domain/actions/executors/add-fulfillment-marker.ts` | Steps 1–3 are the proven core of the executor and the payload is kept verbatim in `onetimes.ts`. Missing: `AutomationAction` record first, idempotency, adopt-existing-one-time check, persist external id, activity log, exception on failure. The route name and `MORNING_MAGIC_2_*` env coupling go. |
| `app/page.tsx` | Local "load subscription / add Morning Magic 2" UI | **Delete** (Phase 2) | Replaced by the subscription detail page's manual "Add marker" action with confirmation. Keep only until the real UI exists. |
| `.env.local` | `RECHARGE_API_TOKEN`, `MORNING_MAGIC_2_*`, Neon vars | **Restructure** | Merchant credentials move into the encrypted `Integration` row; the marker becomes a seeded `FulfillmentMarker`. Env keeps platform secrets only (§15). Neon vars stay. |
| `next.config.ts` (`reactCompiler`, `turbopack.root`) | — | **Retain** | — |
| `app/layout.tsx`, `globals.css`, `public/*.svg`, `README.md` | create-next-app defaults | **Replace** in Phase 1 | Design-system shell. |
| `package.json` name `ancient-subscriptions` | — | **Rename** → `reloop` | Nothing tenant-specific in the core; the repo is already called Reloop. |

**Two facts the POC established that are now architectural constraints:** (a) the one-time must be pinned with `next_charge_scheduled_at = <that subscription's date>` on that subscription's address, never `add_to_next_charge`; (b) Recharge → Shopify → Royal Mail needs nothing further from us.

---

## 3. Target project structure

```text
reloop/  (folder currently ancient-subscriptions/)
├── app/
│   ├── (auth)/login, signup, layout.tsx
│   ├── (app)/                               # authenticated + org-scoped shell
│   │   ├── layout.tsx                       # sidebar, org switcher; requires session + active org
│   │   ├── page.tsx                         # Overview
│   │   ├── subscriptions/page.tsx, [id]/page.tsx
│   │   ├── upcoming/page.tsx
│   │   ├── rules/page.tsx, new/page.tsx, [id]/page.tsx
│   │   ├── products/page.tsx                # tabs: Subscription Products | Fulfilment Markers
│   │   ├── activity/page.tsx
│   │   ├── exceptions/page.tsx
│   │   ├── settings/general|team|integrations/page.tsx
│   │   └── onboarding/page.tsx
│   ├── api/
│   │   ├── auth/[...all]/route.ts           # Better Auth
│   │   ├── webhooks/recharge/[integrationId]/route.ts
│   │   └── jobs/run/route.ts                # cron target, bearer-protected
│   ├── layout.tsx, globals.css              # tokens
├── components/
│   ├── ui/        Button Input Select Textarea Dialog Sheet Badge Table Tabs Tooltip Popover Skeleton Toast Command
│   ├── layout/    Sidebar Topbar PageHeader OrgSwitcher
│   ├── data/      DataTable FilterBar Pagination EmptyState Metric DetailRow KeyValueList
│   ├── status/    StatusBadge IntegrationStatus ExceptionBanner CapabilityList
│   ├── timeline/  Timeline ActivityItem JourneyTimeline
│   └── domain/    RuleSummary RulePreview MarkerCard SubscriptionHeader ConfirmationDialog ImpactPreview
├── lib/
│   ├── auth/      auth.ts session.ts tenancy.ts (OrgContext, requireOrg, requireRole)
│   ├── db/        prisma.ts tenant.ts (org-scoped Prisma extension)
│   ├── crypto/    credentials.ts
│   ├── integrations/
│   │   ├── types.ts registry.ts             # provider-agnostic interface + DTOs
│   │   └── recharge/
│   │       client.ts schemas.ts types.ts mapper.ts errors.ts
│   │       store.ts capabilities.ts customers.ts products.ts subscriptions.ts
│   │       orders.ts charges.ts(read, optional) onetimes.ts webhooks.ts
│   ├── domain/
│   │   ├── organizations/ integrations/ sync/ subscriptions/ journeys/
│   │   ├── rules/        match.ts (pure) preview.ts crud.ts
│   │   ├── actions/      plan.ts execute.ts reconcile.ts executors/add-fulfillment-marker.ts
│   │   ├── events/       inbox.ts dispatch.ts handlers/order.ts subscription.ts onetime.ts
│   │   ├── exceptions/   activity/
│   ├── jobs/      queue.ts runner.ts handlers/*
│   ├── logging/   logger.ts (structured, redacting)
│   └── validation/
├── prisma/        schema.prisma migrations/ seed.ts
├── tests/         unit/ integration/ webhooks/
├── docs/ARCHITECTURE.md
├── .env.example  vercel.json  .gitattributes
```

**Boundary rules (enforced by lint + review):**
1. `app/**` imports only from `lib/domain/**`, `lib/auth/**`, `components/**`. Never from `lib/integrations/**` or `lib/db/prisma.ts` directly.
2. `lib/domain/**` receives connector DTOs, never raw Recharge JSON.
3. Only `lib/integrations/recharge/client.ts` performs HTTP to Recharge.
4. Every domain function's first argument is `ctx: OrgContext`; every tenant query goes through the org-scoped client (§6).

---

## 4. Prisma schema (foundation)

Complete; drops into `prisma/schema.prisma`. Models marked *(support)* are additions to the brief's list, each justified in §5.

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")            // Neon pooled
  directUrl = env("DATABASE_URL_UNPOOLED")   // migrations / db push
}

// ═══════════════════════════ Identity & tenancy ═══════════════════════════

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

// (support) Better Auth tables
model Session {
  id                   String   @id @default(cuid())
  userId               String
  token                String   @unique
  expiresAt            DateTime
  ipAddress            String?
  userAgent            String?
  activeOrganizationId String?
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
  password              String?
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

enum OrganizationRole { OWNER ADMIN OPERATOR VIEWER }

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

// ═══════════════════════════ Integrations ═══════════════════════════

enum IntegrationProvider { RECHARGE }
enum IntegrationStatus   { CONNECTED ERROR DISCONNECTED }
enum AutomationMode      { OFF DRY_RUN LIVE }   // rollout stages 6–9 (§18)

model Integration {
  id                    String              @id @default(cuid())
  organizationId        String
  provider              IntegrationProvider
  status                IntegrationStatus   @default(CONNECTED)
  externalStoreId       String
  displayName           String
  encryptedCredentials  String              // never selected by default (Prisma omit), never logged
  credentialsKeyId      String              @default("v1")
  automationMode        AutomationMode      @default(OFF)
  settingsJson          Json?               // api version, webhook registrations {topic, externalId, address}
  capabilitiesJson      Json?               // {customers:"available", subscriptions:"read_write", events:"unavailable", ...}
  capabilitiesCheckedAt DateTime?
  lastSuccessfulSyncAt  DateTime?
  lastErrorAt           DateTime?
  lastErrorMessage      String?
  createdAt             DateTime            @default(now())
  updatedAt             DateTime            @updatedAt

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

// ═══════════════════════════ Catalogue & customers ═══════════════════════════

// (support) display + search only; minimal PII
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

enum ProductType { SUBSCRIPTION_PRODUCT FULFILMENT_MARKER GIFT_PRODUCT }

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

// (support) variant granularity — one-times and subscriptions are variant-level
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
  organization  Organization        @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  product       Product             @relation(fields: [productId], references: [id], onDelete: Cascade)
  markers       FulfillmentMarker[]
  subscriptions Subscription[]
  rules         AutomationRule[]
  @@unique([productId, externalVariantId])
  @@index([organizationId, sku])
}

model FulfillmentMarker {
  id             String   @id @default(cuid())
  organizationId String
  name           String   // internal: "Morning Magic Cycle 2"
  description    String?  // internal operational meaning: "Include free whisk"
  variantId      String   // the £0 variant inserted into the shipment ("Morning Magic 2", MM-CYCLE-02)
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

// ═══════════════════════════ Subscriptions & journeys ═══════════════════════════

enum SubscriptionStatus { ACTIVE PAUSED CANCELLED EXPIRED UNKNOWN }
enum AutomationOverride { ENABLED DISABLED }   // per-subscription override of Integration.automationMode

model Subscription {
  id                     String             @id @default(cuid())
  organizationId         String
  integrationId          String
  customerId             String?
  externalSubscriptionId String
  externalCustomerId     String
  externalAddressId      String
  status                 SubscriptionStatus @default(UNKNOWN)
  externalStatus         String?

  productId              String?            // null until mapped → Exception PRODUCT_MAPPING_MISSING
  variantId              String?
  externalProductId      String
  externalVariantId      String
  productTitleSnapshot   String
  variantTitleSnapshot   String?
  skuSnapshot            String?

  quantity               Int                @default(1)
  price                  Decimal?           @db.Decimal(10, 2)
  intervalUnit           String?
  intervalFrequency      Int?
  nextChargeAt           DateTime?
  externalCreatedAt      DateTime?
  cancelledAt            DateTime?
  automationOverride     AutomationOverride?

  currentJourneyId       String?            @unique
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

enum JourneyEndReason { PRODUCT_SWAP CANCELLED EXPIRED MANUAL }

model SubscriptionJourney {
  id                String            @id @default(cuid())
  organizationId    String
  subscriptionId    String
  productId         String?
  variantId         String?
  externalProductId String
  externalVariantId String
  sequence          Int
  startedAt         DateTime
  endedAt           DateTime?
  endReason         JourneyEndReason?
  successfulCycles  Int               @default(0)   // denormalised count(JourneyCycle)
  createdAt         DateTime          @default(now())
  updatedAt         DateTime          @updatedAt

  organization Organization       @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  subscription Subscription       @relation("SubscriptionJourneys", fields: [subscriptionId], references: [id], onDelete: Cascade)
  product      Product?           @relation(fields: [productId], references: [id], onDelete: SetNull)
  currentOf    Subscription?      @relation("CurrentJourney")
  cycles       JourneyCycle[]
  actions      AutomationAction[]
  exceptions   Exception[]

  @@unique([subscriptionId, sequence])
  @@index([organizationId, productId])
}

enum CycleSource { WEBHOOK BACKFILL MANUAL }
enum OrderKind   { CHECKOUT RECURRING }

// (support) one row per successful order per journey — idempotent counting + timeline
model JourneyCycle {
  id               String      @id @default(cuid())
  organizationId   String
  journeyId        String
  cycleNumber      Int
  externalOrderId  String
  externalChargeId String?
  orderKind        OrderKind
  processedAt      DateTime
  source           CycleSource
  sourceEventId    String?
  createdAt        DateTime    @default(now())
  organization Organization        @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  journey      SubscriptionJourney @relation(fields: [journeyId], references: [id], onDelete: Cascade)
  sourceEvent  IntegrationEvent?   @relation(fields: [sourceEventId], references: [id], onDelete: SetNull)
  @@unique([journeyId, externalOrderId])
  @@unique([journeyId, cycleNumber])
  @@index([organizationId, processedAt])
}

// ═══════════════════════════ Rules & actions ═══════════════════════════

enum RuleTriggerType            { SUBSCRIPTION_CYCLE }
enum RuleActionType             { ADD_FULFILLMENT_MARKER }
enum ExistingSubscriptionPolicy { FUTURE_ONLY INCLUDE_EXISTING }

model AutomationRule {
  id                  String                     @id @default(cuid())
  organizationId      String
  name                String
  description         String?
  enabled             Boolean                    @default(false)
  priority            Int                        @default(100)
  triggerType         RuleTriggerType            @default(SUBSCRIPTION_CYCLE)
  productId           String
  variantId           String?                    // null = any variant
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

enum ActionType   { ADD_FULFILLMENT_MARKER }
enum ActionSource { RULE MANUAL BACKFILL }
enum ActionStatus { PLANNED EXECUTING SUCCEEDED FAILED CANCELLED SUPERSEDED }

model AutomationAction {
  id                  String       @id @default(cuid())
  organizationId      String
  integrationId       String
  ruleId              String?
  subscriptionId      String
  journeyId           String
  fulfillmentMarkerId String
  type                ActionType   @default(ADD_FULFILLMENT_MARKER)
  source              ActionSource @default(RULE)
  targetCycle         Int
  status              ActionStatus @default(PLANNED)

  // Idempotency (§10): "<journeyId>:<targetCycle>:<fulfillmentMarkerId>" while status ∈
  // {PLANNED, EXECUTING, SUCCEEDED, FAILED}; NULL when CANCELLED / SUPERSEDED.
  liveKey             String?      @unique

  scheduledFor        DateTime?    // subscription's next charge date at planning time
  executedAt          DateTime?
  externalObjectType  String?      // "recharge_onetime"
  externalObjectId    String?
  externalChargeDate  DateTime?    // date the one-time is currently pinned to
  externalAddressId   String?
  dryRun              Boolean      @default(false)
  attemptCount        Int          @default(0)
  nextAttemptAt       DateTime?
  lastError           String?
  lastErrorAt         DateTime?
  cancelReason        String?
  triggeredByEventId  String?
  createdById         String?
  createdAt           DateTime     @default(now())
  updatedAt           DateTime     @updatedAt

  organization      Organization        @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  integration       Integration         @relation(fields: [integrationId], references: [id], onDelete: Cascade)
  rule              AutomationRule?     @relation(fields: [ruleId], references: [id], onDelete: SetNull)
  subscription      Subscription        @relation(fields: [subscriptionId], references: [id], onDelete: Cascade)
  journey           SubscriptionJourney @relation(fields: [journeyId], references: [id], onDelete: Cascade)
  fulfillmentMarker FulfillmentMarker   @relation(fields: [fulfillmentMarkerId], references: [id], onDelete: Restrict)
  triggeredByEvent  IntegrationEvent?   @relation(fields: [triggeredByEventId], references: [id], onDelete: SetNull)
  exceptions        Exception[]

  @@index([organizationId, status, scheduledFor])
  @@index([subscriptionId])
  @@index([status, nextAttemptAt])
}

// ═══════════════════════════ Event inbox ═══════════════════════════

enum IntegrationEventStatus { RECEIVED PROCESSING PROCESSED FAILED IGNORED }

model IntegrationEvent {
  id              String                 @id @default(cuid())
  organizationId  String
  integrationId   String
  provider        IntegrationProvider
  eventType       String                 // "order/processed"
  externalEventId String?
  dedupeKey       String                 // externalEventId ?? sha256(topic + raw body)
  payloadJson     Json
  headersJson     Json?
  signatureValid  Boolean
  receivedAt      DateTime               @default(now())
  processedAt     DateTime?
  status          IntegrationEventStatus @default(RECEIVED)
  attemptCount    Int                    @default(0)
  nextAttemptAt   DateTime?
  lastError       String?

  organization  Organization       @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  integration   Integration        @relation(fields: [integrationId], references: [id], onDelete: Cascade)
  journeyCycles JourneyCycle[]
  actions       AutomationAction[]

  @@unique([integrationId, dedupeKey])
  @@index([status, nextAttemptAt])
  @@index([organizationId, receivedAt])
}

// ═══════════════════════════ Exceptions & activity ═══════════════════════════

enum ExceptionSeverity { INFO WARNING CRITICAL }
enum ExceptionStatus   { OPEN RESOLVED IGNORED }

model Exception {
  id             String            @id @default(cuid())
  organizationId String
  severity       ExceptionSeverity
  type           String            // closed set in code: MARKER_PRODUCT_MISSING, AUTH_FAILED, ... (§12)
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

enum ActorType  { USER SYSTEM INTEGRATION }
enum EntityType { ORGANIZATION USER INTEGRATION PRODUCT FULFILLMENT_MARKER SUBSCRIPTION JOURNEY RULE ACTION EXCEPTION EVENT }

model ActivityLog {
  id             String     @id @default(cuid())
  organizationId String
  actorType      ActorType
  actorId        String?
  eventType      String     // RULE_CREATED, CYCLE_COMPLETED, MARKER_QUEUED, MARKER_MOVED, ACTION_FAILED, ...
  entityType     EntityType
  entityId       String
  summary        String
  metadataJson   Json?
  createdAt      DateTime   @default(now())
  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  @@index([organizationId, createdAt])
  @@index([entityType, entityId])
}

// ═══════════════════════════ Jobs (support, §14) ═══════════════════════════

enum JobStatus { PENDING RUNNING SUCCEEDED FAILED DEAD }

model Job {
  id             String    @id @default(cuid())
  organizationId String?
  type           String    // PROCESS_EVENT EXECUTE_ACTION RECONCILE_SUBSCRIPTION INITIAL_SYNC DAILY_RECONCILE
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

## 5. Model-by-model: purpose, ownership, fields, relations, indexes, uniques, delete behaviour

**Tenant-owned** = has `organizationId`, cascades on org delete, only ever read through the org-scoped client.

| Model | Purpose | Owner | Key fields | Relations | Unique | Indexes | Delete behaviour |
|---|---|---|---|---|---|---|---|
| **User** | A person who can log in | Platform | `email` | → memberships, sessions, accounts | `email` | — | Deleting a user cascades memberships/sessions; never cascades org data. |
| **Session / Account / Verification** | Better Auth state; `Session.activeOrganizationId` carries the current org | Platform | `token`, `activeOrganizationId` | → user | `token`; `(providerId, accountId)` | `userId` | Cascade from user. |
| **Organization** | The tenant | Platform | `slug`, `timezone`, `currency` | → everything tenant-owned | `slug` | — | Cascade deletes the whole tenant world. |
| **OrganizationMembership** | Who belongs to which org, with what role | Platform | `role` | → org, user | `(organizationId, userId)` | `userId` | Cascade from either side. |
| **Integration** | A connected external store + encrypted credentials + capability map + automation mode | Tenant | `provider`, `externalStoreId`, `encryptedCredentials`, `automationMode`, `capabilitiesJson` | → customers, products, subscriptions, actions, events, exceptions | `(organizationId, provider, externalStoreId)` | `organizationId` | Cascade removes imported data; **Disconnect** in the UI sets `status=DISCONNECTED` and wipes credentials rather than deleting, so history survives. |
| **Customer** *(support)* | Minimal person data for display/search | Tenant | `externalCustomerId`, `email`, names | → subscriptions | `(integrationId, externalCustomerId)` | `(org, email)`, `(org, lastName, firstName)` | Cascade from integration; subscription.customerId SetNull. Honour `customer/deleted` by erasing PII fields. |
| **Product** | External product (product-level) with our `type` classification | Tenant | `externalProductId`, `title`, `type` | → variants, subscriptions, journeys, rules | `(integrationId, externalProductId)` | `(org, type, active)` | Cascade from integration; **Restrict** if a rule references it (rule must go first). |
| **ProductVariant** *(support)* | Variant-level identity: what one-times and subscriptions actually reference | Tenant | `externalVariantId`, `sku`, `price` | → markers, subscriptions, rules | `(productId, externalVariantId)` | `(org, sku)` | Cascade from product; **Restrict** from markers. |
| **FulfillmentMarker** | The configurable £0 item + internal operational meaning | Tenant | `name`, `description`, `variantId`, `active` | → variant, rules, actions | `(organizationId, name)` | `(org, active)` | Restrict from rules/actions; deactivate instead of delete. |
| **Subscription** | Our mirror of one provider subscription | Tenant | `externalSubscriptionId`, `externalAddressId`, `status`, `nextChargeAt`, snapshots, `currentJourneyId`, `automationOverride` | → customer, product, variant, currentJourney (1:1), journeys, actions, exceptions | `(integrationId, externalSubscriptionId)`; `currentJourneyId` | `(org,status)`, `(org,productId)`, `(org,nextChargeAt)`, `customerId` | Cascade from integration; journeys/actions cascade with it; `currentJourneyId` SetNull if the journey row goes. |
| **SubscriptionJourney** | One product's run within a subscription — the unit cycles are counted against | Tenant | `sequence`, `productId`/`externalProductId`, `startedAt/endedAt/endReason`, `successfulCycles` | → subscription, product, cycles, actions, exceptions, `currentOf` | `(subscriptionId, sequence)` | `(org, productId)` | Cascade from subscription. |
| **JourneyCycle** *(support)* | One successful order counted for a journey | Tenant | `cycleNumber`, `externalOrderId`, `orderKind`, `processedAt`, `source`, `sourceEventId` | → journey, sourceEvent | `(journeyId, externalOrderId)`, `(journeyId, cycleNumber)` | `(org, processedAt)` | Cascade from journey. |
| **AutomationRule** | Typed V1 rule: product (+variant) × cycle → marker | Tenant | `enabled`, `productId`, `variantId?`, `cycleNumber`, `fulfillmentMarkerId`, `existingPolicy` | → product, variant, marker, actions, exceptions | `(organizationId, name)` | `(org, enabled, productId, cycleNumber)` | Deleting a rule SetNulls `action.ruleId` (history survives); Restrict on product/variant/marker deletion. |
| **AutomationAction** | The audit record and the only thing allowed to cause a Recharge write | Tenant | `status`, `liveKey`, `targetCycle`, `scheduledFor`, `externalObjectId`, `externalChargeDate`, `attemptCount`, `dryRun`, `triggeredByEventId` | → rule?, subscription, journey, marker, triggeredByEvent?, exceptions | **`liveKey`** | `(org,status,scheduledFor)`, `subscriptionId`, `(status,nextAttemptAt)` | Cascade from subscription/journey; Restrict from marker. |
| **IntegrationEvent** | Our webhook inbox: exactly what an external system told us, raw | Tenant | `eventType`, `dedupeKey`, `payloadJson`, `signatureValid`, `status`, `attemptCount` | → integration, journeyCycles, actions | `(integrationId, dedupeKey)` | `(status, nextAttemptAt)`, `(org, receivedAt)` | Cascade from integration. Never populated from `/events`. |
| **Exception** | Operator inbox item: something needs a human or happened automatically but notably | Tenant | `severity`, `type`, `status`, `autoResolved`, links | → integration?, subscription?, journey?, rule?, action? (all SetNull) | — | `(org,status,severity)`, `(org,detectedAt)` | Survives deletion of the things it references. |
| **ActivityLog** | Human-readable operational history | Tenant | `actorType/actorId`, `eventType`, `entityType/entityId`, `summary` | → org only (polymorphic entity ref by design) | — | `(org, createdAt)`, `(entityType, entityId)` | Cascade from org only. |
| **Job** *(support)* | Durable background work | Platform/Tenant | `type`, `payloadJson`, `dedupeKey`, `runAt`, `attempts` | → org? | `dedupeKey` | `(status, runAt)` | Cascade from org when set. |

**Enum design principle:** enums for closed sets the schema must reason about (statuses, roles, sources); `String` for sets that grow with product work and only code reasons about (`Exception.type`, `ActivityLog.eventType`, `Job.type`) — each backed by a `as const` union in code so a migration isn't needed to add one.

---

## 6. Guaranteeing tenant isolation

Layered, so that a mistake in any one layer is caught by another:

1. **Identity → org resolution happens once, server-side.** `requireOrg()` reads the session, loads `activeOrganizationId`, verifies a `OrganizationMembership` exists for this user, and returns `OrgContext { organizationId, userId, role }`. Form inputs and URL params are never a source of `organizationId`.
2. **An org-scoped Prisma client, not discipline.** `lib/db/tenant.ts` exports `dbFor(ctx)` — a Prisma client extension that, for every tenant-owned model, injects `organizationId: ctx.organizationId` into `where` for `findMany/findFirst/findUnique*/update*/delete*/count/aggregate` and into `data` for `create/createMany`. A `findUnique({ where: { id } })` on a tenant model becomes `findFirst({ where: { id, organizationId } })`. The raw `prisma` export is only imported by `lib/auth`, the webhook route (which resolves the org from the integration in the URL and then builds a ctx), and the job runner (which builds a ctx from `job.organizationId`). A lint rule forbids `from "@/lib/db/prisma"` anywhere else.
3. **Nested writes are scoped too.** Relation ids supplied by a client (`productId`, `fulfillmentMarkerId`, …) are validated inside the domain function with a scoped lookup before use — you cannot attach org B's marker to org A's rule.
4. **Webhooks:** org is derived from `integrationId` in the URL and the HMAC is verified with *that* integration's secret; a valid signature for integration X cannot write into integration Y.
5. **Jobs:** every job payload carries `organizationId`; the handler builds its ctx from the job row, never from the payload alone.
6. **Tests:** Phase 1 ships a cross-tenant probe for every tenant model — create in org A, attempt every read/write via org B's ctx, assert not found / rejected. This test list is the schema's own list of tenant models, so a new model can't be forgotten.
7. **Defense in depth later (not V1):** Postgres RLS with `SET LOCAL app.org_id` per transaction. Real value, real complexity with Prisma; worth adding before any external tenant is onboarded, not before.
8. **Credentials** are excluded from default selects via Prisma `omit` so they cannot accidentally flow into a server component or JSON response.

---

## 7. How `Subscription` and `SubscriptionJourney` interact

- `Subscription` is the *identity and current state* of one provider subscription: who, which address, which product now, next charge, status. It is overwritten on every sync/webhook.
- `SubscriptionJourney` is *a period during which that subscription was for one product*. Subscription `S` has journeys `1..n`; exactly one is current, enforced by `Subscription.currentJourneyId` (unique FK → journey). Rules, cycles and actions all hang off the **journey**, never the subscription directly, because "cycle 2 of Morning Magic" is a statement about the Morning Magic run, not about subscription id 123.

```text
Subscription 123 (Recharge)  currentJourneyId → J2
├── J1  seq 1  Morning Magic   cycles 2   ended PRODUCT_SWAP
│     ├── cycle 1  order 9001 (CHECKOUT)
│     ├── cycle 2  order 9117 (RECURRING)
│     └── action  cycle 3 marker  CANCELLED "subscription swapped"
└── J2  seq 2  Cacao           cycles 1   current
      ├── cycle 1  order 9230
      └── action  cycle 3 marker  PLANNED (Cacao rule)
```

Queries the UI needs (list "completed cycles", "next action") read `currentJourney.successfulCycles` and the live action on `currentJourney` — both one join, no aggregation.

---

## 8. Exactly how successful cycle counting works

**Definition (code + docs + UI tooltip say the same thing):** *A cycle is one successful Recharge order containing this subscription's line item, counted within the current product journey. The checkout order is cycle 1.* Not Shopify customer order count, not charges attempted, not months elapsed, not address-level sequence.

**Source of truth:** Recharge **Orders** (`status = success`, i.e. the charge succeeded and the order was created in Shopify), matched to the subscription by line-item `purchase_item_id` (2021-11; `subscription_id` in older payloads). Never customer-wide.

**The counting function is one transaction and is pull-based:**

```text
recordSuccessfulOrder(ctx, integration, externalOrderId, source, sourceEventId?)
  order = recharge.orders.get(externalOrderId)              # fetch truth; webhook is only the trigger
  if order.status != success → IGNORED (log), return
  for line in order.lineItems where line.purchaseItemType == subscription:
    sub = Subscription by (integrationId, line.purchaseItemId)   # unknown → enqueue sync + WARNING exception
    BEGIN
      SELECT journey FOR UPDATE where id = sub.currentJourneyId   # serialises per subscription
      if line.externalProductId != journey.externalProductId:
          journey = swapJourney(sub, journey, line.product, reason=PRODUCT_SWAP, at=order.processedAt)  # §9
      INSERT JourneyCycle(journeyId, externalOrderId, cycleNumber = journey.successfulCycles + 1, ...)
         ON CONFLICT (journeyId, externalOrderId) DO NOTHING → if nothing inserted: COMMIT, return (replay)
      journey.successfulCycles += 1
      nextCycle = journey.successfulCycles + 1
      ActivityLog CYCLE_COMPLETED
      evaluateRules(ctx, journey, nextCycle, triggeredByEventId)      # §11 — plans actions inside the same tx
    COMMIT
```

**Backfill (Phase 3)** runs the same function over `orders.list({ purchase_item_id or customer_id, status: success })` ordered by `processed_at` ascending, with `source = BACKFILL` and rules **not** evaluated (backfill is read-only; planning happens in Phase 9's reviewed flow). Because the unique key is the order id, re-running a backfill or receiving a webhook for an already-backfilled order changes nothing.

**Policies stated explicitly:** refunds/cancellations after processing do **not** decrement (the shipment went out); an order with `status = error` never counts; an order that later flips from error → success (retry) counts once when we see success.

**Uncertainty flagged:** whether `GET /orders` filters by `purchase_item_id` in 2021-11 is confirmed in Phase 3 against the live store; the fallback (`customer_id` filter + line-item match) is the same algorithm with more paging.

---

## 9. How product swaps work

Two detection paths, same outcome, both idempotent:

1. **`subscription/swapped` (or `subscription/updated` with a different `external_product_id`)** → `swapJourney()`: end current journey (`endedAt = now, endReason = PRODUCT_SWAP`), create journey `seq+1` for the new product/variant with `successfulCycles = 0`, repoint `currentJourneyId`, then **reconcile** every live action on the old journey: fetch its one-time; if it exists, delete it (the upcoming charge will now ship the new product, so the old product's marker is wrong); action → `CANCELLED`, reason "product swapped before target cycle"; ActivityLog `MARKER_REMOVED`, `SUBSCRIPTION_SWAPPED`. Then evaluate rules for the new journey with `nextCycle = 1` (rules for cycle 1 are unusual but legal).
2. **Order-driven** (§8): if a successful order's product differs from the current journey's product, the swap is applied *before* recording the cycle on the new journey. This covers swaps we missed or that arrived out of order.

Historical cycle counts on the ended journey are preserved forever. Swapping back starts a third journey at 0 — the brief's rule. A future `journeyResumePolicy` could resume a prior journey for the same product; not V1.

**Same product, different variant** (e.g. size change): V1 treats it as the same journey (variant updated on the journey), since rules are usually product-level. Flagged as a decision (§19).

---

## 10. How idempotency prevents duplicate physical gifts

Four independent gates; any one of them alone would prevent a duplicate gift.

1. **Event gate** — `IntegrationEvent (integrationId, dedupeKey)` unique: a redelivered webhook is stored once and processed once.
2. **Cycle gate** — `JourneyCycle (journeyId, externalOrderId)` unique: the same order can never increment twice, so the same "next cycle" is never evaluated twice *as a new milestone*.
3. **Action gate — the one that matters most** — `AutomationAction.liveKey` unique = `journeyId:targetCycle:fulfillmentMarkerId` while live. Two concurrent planners (two webhook deliveries, a webhook + a backfill, a user double-click on "Add marker") race on the insert; exactly one wins; the other receives a unique-violation and treats it as "already planned" — no `if (!existing)` anywhere. I deliberately key on **marker** rather than **rule**: the physical invariant is "this marker ships at most once per journey-cycle", and that must hold for manual additions (no rule) and for two rules that happen to point at the same marker. Rule id is still stored for audit.
4. **External gate** — the executor does read-before-write against Recharge: list one-times for `(addressId, date)`; if one matches the marker variant and is not owned by another of our actions, **adopt** it (store its id, mark `SUCCEEDED`, log "adopted existing one-time") instead of creating. This handles the timeout-after-success case (`POST /onetimes` succeeded, our HTTP call died, the retry would otherwise create a second). Recharge offers no idempotency key on this endpoint, so this check is mandatory, not optional.

Transitions that null `liveKey` (→ `CANCELLED`/`SUPERSEDED`) happen in the same transaction as the status change, in one function (`transitionAction`). Nothing else writes `status`.

---

## 11. The `IntegrationEvent → Rule → AutomationAction` lifecycle

```text
IntegrationEvent      RECEIVED ──► PROCESSING ──► PROCESSED
                                        │            (or IGNORED: irrelevant topic / no-op)
                                        └──► FAILED ──(backoff, ≤5)──► PROCESSING … ──► DEAD-ish: FAILED + Exception

Handler (order/*)     fetch order → recordSuccessfulOrder (§8) → evaluateRules
evaluateRules         rules = enabled ∧ productId = journey.productId ∧ (variantId ∅ ∨ = journey.variantId)
                             ∧ cycleNumber = nextCycle,  ordered by priority
                      for each: planAction(journey, nextCycle, rule.marker, scheduledFor = sub.nextChargeAt)
AutomationAction      PLANNED ──► EXECUTING ──► SUCCEEDED
                         │            │
                         │            ├──► FAILED (retriable: nextAttemptAt; terminal: + Exception)
                         │            │        └──► EXECUTING (retry / manual retry)
                         ├──► CANCELLED  (sub cancelled/swapped/paused before target cycle; reason recorded)
                         └──► SUPERSEDED (replaced by a new live action for the same milestone:
                                           marker changed on rule, or one-time had to be recreated on a new date)
Execution             PLANNED → enqueue EXECUTE_ACTION (immediately in V1, or at scheduledFor − leadDays later)
                      DRY_RUN mode: executor validates everything, logs "would create", leaves PLANNED with dryRun=true
                      LIVE: §17 steps; on success store externalObjectId/externalChargeDate → SUCCEEDED → ActivityLog MARKER_QUEUED
Lifecycle events      subscription/skipped|unskipped|updated|cancelled|swapped → RECONCILE_SUBSCRIPTION job (§19 handling)
                      onetime/deleted for one we own → Exception WARNING MARKER_REMOVED_EXTERNALLY (policy decision, §19)
```

Every arrow writes an `ActivityLog` row with `actorType = SYSTEM` and the ids needed to trace it; every Recharge call logs `correlationId` = the action id.

---

## 12. Failure, retry and exception architecture

**Error classification lives in the connector** (`errors.ts`): `RechargeError { kind, status, retriable, requestId }` with kinds `RATE_LIMITED (429)`, `SERVER (5xx)`, `NETWORK/TIMEOUT`, `AUTH (401)`, `FORBIDDEN (403 / missing permission)`, `NOT_FOUND (404)`, `VALIDATION (422/400)`, `UNKNOWN`. Only the first three are `retriable`.

**Two retry layers:**
- *Client-level* (inside `client.ts`): up to 3 quick retries with jitter for `retriable` kinds, honouring `Retry-After` / Recharge's `X-Recharge-Limit` headers; 15 s timeout per request.
- *Job-level* (runner): if the handler still throws a retriable error, `attempts++`, `nextAttemptAt = now + [1m, 5m, 15m, 1h, 6h][attempts]`; after `maxAttempts` → `FAILED` and an Exception.

**Terminal errors never retry.** They transition the action to `FAILED` immediately and open an Exception:

| Exception type | Severity | Typical cause | What the operator sees |
|---|---|---|---|
| `MARKER_PRODUCT_MISSING` | CRITICAL | 404 on the marker variant | "Configured fulfilment marker product no longer exists" + which rule/marker |
| `AUTH_FAILED` | CRITICAL | 401 | integration → ERROR; all actions for it paused |
| `PERMISSION_MISSING` | CRITICAL | 403 on required resource | capability panel shows what's missing |
| `SUBSCRIPTION_NOT_ACTIVE` | WARNING | cancelled/expired at execution | action CANCELLED (auto-resolved) |
| `CHARGE_DATE_MISSING` | WARNING | `next_charge_scheduled_at` null | action held |
| `MARKER_ALREADY_EXISTS` | WARNING | external one-time found, not ours | adopted or held per policy |
| `MARKER_REMOVED_EXTERNALLY` | WARNING | onetime/deleted for our object | policy §19 |
| `JOURNEY_UNRESOLVED` | CRITICAL | order line for unknown subscription/product | sync enqueued; nothing planned |
| `PRODUCT_MAPPING_MISSING` | WARNING | subscription product not in catalogue | import continues |
| `WEBHOOK_SIGNATURE_INVALID` | WARNING (rate-limited) | bad HMAC | security signal |
| `DRIFT_DETECTED` | WARNING/CRITICAL | reconciliation mismatch | details in metadata |

Exceptions are deduped per `(type, actionId|subscriptionId)` while OPEN so a retry storm produces one inbox item, not fifty. Auto-resolved ones (`autoResolved = true`) are shown separately from ones needing a person.

---

## 13. Recharge webhook processing without the Events API

**Registration (Phase 6):** `POST /webhooks { address: https://<host>/api/webhooks/recharge/<integrationId>, topic }` for `order/created`, `order/processed`, `order/updated`, `subscription/created|updated|cancelled|skipped|unskipped|swapped|activated`, `onetime/created|updated|deleted`. These are permissioned by `read_orders` / `read_subscriptions` — `read_events` is not required. Registration ids are stored in `Integration.settingsJson`; a "Re-register webhooks" button exists for environment changes. (Charge topics are optional; our design doesn't depend on them.)

**Endpoint (`POST /api/webhooks/recharge/[integrationId]`):**
1. Load integration by id (unscoped lookup, then ctx from its org). Unknown → 404.
2. Read the **raw** body; compute HMAC-SHA256 with the integration's decrypted client secret; constant-time compare to `X-Recharge-Hmac-Sha256`. Invalid → 401, record a rate-limited `WEBHOOK_SIGNATURE_INVALID` exception, do **not** store payload.
3. Minimal Zod parse (topic header + `{ <object>: { id } }`); malformed → store as `IGNORED` with error, 200 (so Recharge stops retrying junk).
4. Upsert `IntegrationEvent` with `dedupeKey = sha256(topic + raw body)` (Recharge doesn't supply a stable delivery id; identical redeliveries hash identically). Conflict → 200, done.
5. Return **200 immediately**. Then `after(() => enqueue PROCESS_EVENT(eventId))` — the cron sweeper also picks up any `RECEIVED` event older than 60 s, so a failed `after()` only adds latency, never loses work.

**Handlers are "fetch truth and reconcile", not "apply delta":** an `order/processed` handler fetches the order; a `subscription/*` handler fetches the subscription and enqueues `RECONCILE_SUBSCRIPTION`. This makes out-of-order delivery harmless and lets the same handlers run from reconciliation with no webhook at all. Per-subscription serialisation comes from the `FOR UPDATE` on the journey row (§8) and a per-subscription job `dedupeKey` for reconcile jobs.

**Replay:** any event can be re-queued from the UI (Activity → event → "Replay"); because processing is idempotent it's safe.

---

## 14. Background jobs on Vercel — assessment and choice

| Option | Fit | Strengths | Costs / risks |
|---|---|---|---|
| **Postgres `Job` table + Vercel Cron + `after()`** | ✅ recommended V1 | No vendor; our transactions, our retry columns; `SELECT … FOR UPDATE SKIP LOCKED` gives safe concurrency; replay is a row update | We write the runner (~200 lines); cron granularity = 1 min on Pro (daily on Hobby — Pro is required); long imports must be chunked under function `maxDuration`; near-real-time depends on `after()` + sweep |
| Inngest | ✅ strong alternative | Durable steps, retries, per-key concurrency, crons, replay UI, local dev server; functions still live in our Next.js app | Vendor in the critical path; debugging via their dashboard; another secret |
| Trigger.dev / QStash | ok | Similar to above | Same vendor trade-off; QStash lacks step durability |
| Vercel Queues | not yet | Native | Beta; not something to build physical fulfilment on today |

**Decision:** DB-backed queue for V1, behind a tiny interface (`enqueue / claim / complete / fail`). If we find ourselves re-implementing step durability (e.g. multi-step imports that must survive function timeouts), switch to Inngest — the handlers don't change, only the runner. Scheduled work: `* * * * *` sweep (`PROCESS_EVENT`, `EXECUTE_ACTION`, `RECONCILE_SUBSCRIPTION`), `0 */6 * * *` near-term action verification, `0 3 * * *` daily integration reconciliation. Runner is bearer-protected (`CRON_SECRET`), claims ≤ N jobs per invocation, and stops at ~80% of `maxDuration`.

---

## 15. Credential encryption and storage

- **Algorithm:** AES-256-GCM, random 96-bit IV per encryption, AAD = `integrationId` (binds the ciphertext to its row — a copied blob won't decrypt under another integration).
- **Format:** `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url). `credentialsKeyId` on the row + `CREDENTIAL_ENCRYPTION_KEYS` env (`keyId:base64key,…`) enables rotation: decrypt with the old key, re-encrypt with the current, one job.
- **Contents:** JSON `{ apiToken, clientSecret }` — the client secret is needed server-side for webhook HMAC.
- **Access:** only `lib/integrations/recharge/client.ts` via `createClientForIntegration(integrationId)`, which decrypts in memory for the duration of the call. Prisma `omit` hides the column from every default select. The logger redacts anything matching the token shape and never serialises request headers. Decrypted values are never returned by any server action or route.
- **At rest:** Neon encrypts storage; this layer exists so a DB dump or a mis-scoped query still yields nothing usable.
- **Operational:** the Neon password currently in `.env.local` should be rotated before production and then live only in Vercel env; `CREDENTIAL_ENCRYPTION_KEYS` likewise.

---

## 16. Navigation and UI architecture

Sidebar exactly as the brief (Overview · Subscriptions · Upcoming · Rules · Products · Activity · Exceptions · — · Org switcher · Settings). Every page follows one skeleton: `PageHeader` (title, one-line context, primary action) → optional `FilterBar` → content → consistent empty/loading/error states. Technical ids live in a collapsed "External references" section, never in headers.

| Page | Primary question it answers | Main content |
|---|---|---|
| Overview | Is my automation healthy? | 4 `Metric`s (active subscriptions · actions next 7 days · successful actions 30 days · open exceptions) → Upcoming actions table → Recent activity → Exceptions (only if any) |
| Subscriptions | Where is everyone in their journey? | Server-paged `DataTable`: customer · product · status · completed cycles · next charge · next action · integration; search + filters in URL params |
| Subscription detail | What happened / will happen to this one? | Header (product, status, customer, next charge) → `JourneyTimeline` → current details → actions → activity → external refs |
| Upcoming | What will the system do before orders go out? | Date-grouped list of live actions with status; filters date/product/marker/status |
| Rules | What automation is configured? | Rule rows with `RuleSummary` sentence, enabled toggle (confirmation), last triggered, affected count |
| Rule builder | — | 3 steps + `RulePreview` + `ImpactPreview` → Save disabled / Save & activate |
| Products | What products and markers exist? | Tabs; marker detail with operational note, linked rules, recent uses |
| Activity | What has happened? | Filterable timeline of `ActivityLog` |
| Exceptions | What needs me? | Inbox grouped by severity; needs-action vs auto-resolved; resolve/ignore with note |
| Settings | — | General · Team · Integrations (connect flow + capability panel + automation mode) |

Rendering: server components for all reads; server actions (Zod-validated, ctx-scoped) for mutations; client components only for interactivity. Fast by default.

---

## 17. Design-system primitives to establish early

**Tokens (`globals.css`):** neutral scale with a slight cool bias, one restrained accent, semantic set `success / warning / danger / info / neutral` defined once and used only via `StatusBadge` + `ExceptionBanner`. Geist Sans (already in the scaffold; fits the Linear/Vercel references) + Geist Mono for ids, SKUs and numerals; `tabular-nums` in every table. Light and dark from day one via tokens.

**Primitives (`components/ui`):** Button (primary/secondary/ghost/danger, sizes), Input, Select, Textarea, Checkbox/Switch, Dialog, Sheet, Tooltip, Popover, Dropdown menu, Tabs, Badge, Table, Skeleton, Toast, Command palette (later).

**Composites:** `PageHeader`, `Metric`, `StatusBadge` (the *single* status→colour map for subscription/action/exception/integration statuses), `DataTable` (server pagination, column defs, row link), `FilterBar` (URL-synced), `EmptyState` (icon, title, body, CTA — used for first-run states), `Timeline` / `ActivityItem` / `JourneyTimeline`, `DetailRow` / `KeyValueList`, `ConfirmationDialog` (title, impact sentence, typed confirm for destructive), `RuleSummary` / `RulePreview` / `ImpactPreview`, `IntegrationStatus` / `CapabilityList`, `ExceptionBanner`, `OrgSwitcher`.

Rule: no component defines its own status colours; no page defines its own table styles.

---

## 18. Phased implementation plan with definitions of done

| Phase | Build | Definition of done |
|---|---|---|
| **1 Foundation** | `.gitattributes`, rename package → `reloop`; Prisma + Neon + schema + first migration; `credentials.ts` + tests; Better Auth signup/login; `requireOrg`, org-scoped client, cross-tenant tests; onboarding (create org → OWNER); org switcher; tokens + primitives + shell + sidebar; settings skeleton; seed "Ancient Extracts Demo" (20 customers, 30 subscriptions, 4 products, journeys, rules, actions, activity, one CRITICAL exception); all pages render seed data with proper empty states | Sign up → create org → navigate a polished shell showing realistic demo data; cross-tenant tests green; no Recharge code yet |
| **2 Recharge connector (read)** | `client.ts` (refactor of `lib/recharge.ts`) with timeout/retry/rate-limit/correlation/redaction; Zod schemas + mapper; `store/capabilities/customers/products/subscriptions/orders/onetimes(read)`; Integrations page: test → capability panel → save encrypted → connected card; `Job` queue + `/api/jobs/run` + cron; `INITIAL_SYNC` (customers, products/variants, subscriptions); delete POC routes/page | Ancient Extracts connects; capability panel says required = available; subscriptions appear in `/subscriptions`; zero writes to Recharge |
| **3 Subscription intelligence** | Historical orders → journeys + `JourneyCycle` (BACKFILL); swap detection; subscription list (server search/filter/paging); subscription detail with timeline; `PRODUCT_MAPPING_MISSING` | For 10 hand-picked AE subscriptions, product / journey / cycles / next charge match Recharge exactly (rollout stage 4) |
| **4 Rules** | Products page + markers; rule CRUD + 3-step builder + preview; pure matcher + tests; activation `ImpactPreview` + `existingPolicy`; confirmations | "Morning Magic cycle 2 → Morning Magic 2" exists and previews impact; nothing executes |
| **5 Action engine** | `planAction` (liveKey) + concurrency test; `execute.ts` state machine + retry classes; executor incl. adopt-existing; `automationMode` OFF/DRY_RUN/LIVE + `automationOverride`; manual "Add marker" with confirmation; Upcoming page; action history | DRY_RUN logs "would create" for a test subscription; LIVE for one allow-listed AE test subscription creates the £0 one-time on the exact renewal date; running it again does nothing (rollout stages 5–7) |
| **6 Webhooks** | `webhooks.ts` register; endpoint with HMAC + inbox + `after()`; `PROCESS_EVENT` dispatch; order handlers → `recordSuccessfulOrder`; tests (valid/invalid sig, duplicate, out-of-order, malformed) | A real renewal updates cycle state unattended |
| **7 Automatic fulfilment** | Cycle → rules → plan → execute wired; per-subscription allowlist first | End-to-end unattended for the test subscription, validated again through Shopify → Royal Mail (stage 8) |
| **8 Reconciliation** | `RECONCILE_SUBSCRIPTION` on lifecycle topics (move/delete/recreate one-time; cancel with reason; swap handling); near-term action verification; daily integration reconcile; drift exceptions; `MARKER_REMOVED_EXTERNALLY` policy | Skip, move, cancel, swap on the test subscription all leave Recharge and our DB consistent, each move logged |
| **9 Existing-subscriber backfill** | Review screen → bulk plan BACKFILL actions → explicit confirm → execute; progressive rollout controls | AE's existing Morning Magic subscribers queued for cycle 2 after a reviewed run (stage 9) |

Rollout stages 1–9 from the brief map onto phases 2→3→3→4→5→5→7→9 as marked.

---

## 19. Where I think the brief is wrong, risky, or heavier than needed

1. **Idempotency key should be marker-based, not rule-based.** The brief says `(org, journey, rule, targetCycle)`. That allows two physical duplicates when two rules point at the same marker, and doesn't cover manual additions (no rule). `(journey, targetCycle, marker)` is the physical invariant; rule id stays for audit. *(Changed in the schema.)*
2. **"Attach the marker immediately when planned" has a real exposure risk.** Recharge sends "upcoming order" emails and shows upcoming items in the customer portal, where customers can **delete one-times themselves**. Attaching a month early means (a) the surprise is visible, (b) a customer can remove it, (c) more time for date drift. Options: attach immediately (simplest, most robust to job failures) vs attach `leadDays` before charge (less exposure, depends on the job engine). **Recommendation:** V1 attaches immediately *and* reconciliation treats `onetime/deleted` on our object as `MARKER_REMOVED_EXTERNALLY` (WARNING, not re-added automatically — a customer removing a free item is a signal, not an error). Add `Organization.attachLeadDays` in Phase 8 if exposure proves to be a problem. This is a product decision you should make consciously.
3. **"Cycle = successful processed order" is a proxy for "shipped".** Recharge knows nothing about shipping. That's fine and unavoidable, but the UI should say "Delivery 1 · processed 24 Aug", not "Shipped ✓", unless Shopify fulfilment data is added later. Small wording point with trust implications.
4. **`SUPERSEDED` needs a definition or it becomes a dumping ground.** I've defined it narrowly: a live action replaced by a newer live action for the same milestone (marker changed on the rule, or the one-time had to be recreated). Everything else is `CANCELLED` with a reason.
5. **Rule uniqueness is a UX concern, not a safety concern.** Don't bother with a composite unique on `(product, variant, cycle, marker)` — nullable `variantId` makes it awkward in Postgres, and the action-level `liveKey` already guarantees no duplicate gift. Warn in the builder instead.
6. **Recharge has no first-class "paused" status in 2021-11.** `PAUSED` in our enum is derived (active with no/far-future next charge, or via Recharge's pause feature depending on plan). Treat it as display state; reconciliation keys off `nextChargeAt`, not off the label.
7. **Webhook dedupe "external event identity" may not exist.** Recharge payloads don't carry a stable delivery id, so the dedupe key is a hash of topic + body. Fine, because handlers are idempotent anyway.
8. **`subscription/swapped` can arrive after the first new-product order** (or be missed). Swap handling must also be order-driven (§9). The brief's webhook-only framing would leave a gap.
9. **Verifying the marker "on the upcoming charge" (§17 step 5) needs the Charges resource**, which Recharge groups under the Orders permission. I've added read-only `charges.ts` as an optional, probed capability; if unavailable we verify via `GET /onetimes?address_id`, which is under the Subscriptions permission we already hold.
10. **Product swap = same product, different variant?** The brief treats swaps at product level. A size change (same product) should *not* reset the journey in most businesses. V1: same product → same journey. Flagged for confirmation.
11. **Customers table = PII.** Keep it to name + email, honour `customer/deleted`, and don't sync phone/address. Worth saying out loud before any external tenant.
12. **Team/roles:** four roles in the schema, but V1 UI should enforce only OWNER/ADMIN (manage) vs everyone else (view + operate). Building a permission matrix now is premature.
13. **Not a challenge, a confirmation:** the brief's instinct to keep V1 rules as typed columns and to avoid a JSON DSL is right; so is keeping Shopify out of V1; so is the monolith.

---

## 20. Decisions to confirm

| # | Decision | Recommendation |
|---|---|---|
| D1 | Auth | Better Auth (email+password, DB sessions); our own org/membership tables |
| D2 | Jobs | Postgres `Job` + Vercel Cron (Pro) + `after()`; Inngest as the escape hatch |
| D3 | Current org | on the session; brief's URLs unchanged |
| D4 | Cycle definition | successful Recharge order per journey; checkout = cycle 1; no decrement on refund |
| D5 | Idempotency key | `(journey, targetCycle, marker)` via `liveKey` |
| D6 | Attach timing | immediately; `MARKER_REMOVED_EXTERNALLY` = WARNING, no auto re-add; `attachLeadDays` later if needed |
| D7 | Variant swap | same product, different variant = same journey |
| D8 | Schema additions | `ProductVariant`, `JourneyCycle`, `Customer`, `Job`, auth tables, `automationMode`/`automationOverride`, `dryRun`, `triggeredByEventId` |
| D9 | Naming | package → `reloop`; folder rename optional |
| D10 | Recharge plan independence | hard rule; V1 permissions = Customers/Orders/Products/Store view + Subscriptions view & manage; `IntegrationEvent` = webhooks only; capability probe on connect |

Reply with changes, or "go" to start Phase 1 exactly as written.

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

> Historical proposal. The live schema is `prisma/schema.prisma`; Phase 3 renamed `currentJourneyId` → `latestJourneyId`, added `RuleStatus` / `EligibilityScope` / `MarkerSource`, `milestoneKey`, `CHECK (cycleNumber >= 2)` and integration-scoped markers (§23).

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

> Phase 3 (§23): the pointer is now `latestJourneyId` — it names the *latest* segment and says nothing about actionability, which is a separate two-layer evaluation. The text below keeps the original name for history.

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

---

## 21. Locked decisions (21 Aug 2026) — supersedes §4, §11, §14, §20 where they differ

**`prisma/schema.prisma` is now the source of truth for the data model.** This section records what changed and why.

### D2 — Inngest is the durable execution layer; Postgres is the source of truth
- `app/api/inngest/route.ts` serves functions from `lib/jobs/functions/*`. Every function takes only stable internal ids (`{ integrationEventId }`, `{ automationActionId }`, `{ subscriptionId }`, `{ integrationId }`) and loads current state from the DB. Credentials are decrypted inside the connector call, never carried in event payloads.
- Webhook route: identify integration → verify HMAC → minimal Zod parse → dedupe key → persist `IntegrationEvent` → `inngest.send({ name: "integration/event.received", id: eventId, data: { integrationEventId } })` → 200. Inngest event `id` = our row id, so a double-send is a no-op on their side too.
- Error classification in the connector: transient (429/5xx/network/timeout/DB connectivity) → throw, Inngest retries with backoff; permanent (auth, permission, missing product/subscription, validation, impossible state) → `NonRetriableError` + action FAILED/CANCELLED + Exception.
- Schedules are Inngest cron functions: dispatch due actions (every 10 min: `status=PLANNED AND executeAfter <= now`), T-24h verification, daily integration reconcile, and a 5-minute sweep that re-sends any `IntegrationEvent` still `RECEIVED` with `dispatchedAt` null older than 2 min (in-Inngest backup for a failed send). Vercel Cron is not in the critical path; a `/api/jobs/ping` fallback may be added later.
- Per-subscription serialisation: Inngest `concurrency: { key: "event.data.subscriptionId", limit: 1 }` on event-processing and reconcile functions, plus the `FOR UPDATE` on the journey row inside the transaction.
- `Job` model removed. `attemptCount / lastError / nextAttemptAt / executeAfter / externalObjectId / dispatchedAt` live on `AutomationAction` / `IntegrationEvent` so the state is recoverable without Inngest.

### D6 — Planned-action model with a lead-time window
- **Decide** on cycle N−1 (immediately): `planAction()` creates `PLANNED` with `targetCycle = N`, `targetChargeDate` (Recharge's date-only value), `targetChargeAt`, `executeAfter`. Visible at once in Upcoming / detail / history.
- **Attach** at `executeAfter = targetChargeAt − Organization.markerLeadHours` (default 72; org-configurable later). If already inside the window at planning → `executeAfter = now`.
- **Dates:** Recharge gives a date, not an instant. `targetChargeAt` = local midnight of `targetChargeDate` in the organisation's timezone (the earliest instant the charge could run). All windows are computed from that; no hard-coded UTC hour anywhere. The one-time is still created with `next_charge_scheduled_at = targetChargeDate` exactly — we choose *when our call happens*, never *which charge it belongs to*.
- **Status vocabulary** (replaces SUCCEEDED): `PLANNED → EXECUTING → ATTACHED → FULFILLED`, plus `FAILED`, `CANCELLED`, `SUPERSEDED`. `ATTACHED` = one-time exists in Recharge on the target date. `FULFILLED` = cycle N's order was recorded *and contained the marker line* (`fulfilledByCycleId`). Cycle N processed without the marker → `FAILED` + `MARKER_MISSED`. A reschedule that makes us delete a one-time moves `ATTACHED → PLANNED` (logged) with a recomputed `executeAfter`; `SUPERSEDED` stays narrow (rule's marker changed).
- **Checks:** at plan — rule/marker valid, subscription active, next cycle sensible; before attach — refresh subscription, same journey/program, charge date present (update `targetChargeDate/At` on legitimate reschedule), marker variant exists, not already present (adopt if present); at T-24h — one-time exists, date matches, subscription valid, no duplicate; drift → repair if safe else Exception.

### D7 — SubscriptionProgram decides journey identity
- `SubscriptionProgram { organizationId, name, description, active }` and `SubscriptionProgramProduct { programId, productId, variantId?, variantScope }` where `variantScope = variantId ?? "*"` and `@@unique([organizationId, productId, variantScope])` — any product/variant resolves to **at most one** program; a variant row wins over a product-level row.
- `SubscriptionJourney.programId` is required. Variant change within the same program → same journey, `variantId` updated, `SUBSCRIPTION_VARIANT_CHANGED` activity. Product/variant resolving to a different program → end journey (`PROGRAM_CHANGE`), new journey at 0. Unresolvable → `Subscription.mappingStatus = UNMAPPED`, no journey, pending automation cancelled, `PRODUCT_MAPPING_MISSING` exception; a re-map job creates journeys and backfills cycles once the mapping exists.
- `AutomationRule.programId` replaces `productId/variantId`. Three concepts stay separate: **Product** (catalogue), **SubscriptionProgram** (lifecycle grouping), **FulfillmentMarker** (operational item).

### Other changes
- Package renamed `subscription-ops` (neutral placeholder; no public brand chosen). Folder rename deferred.
- Prisma pinned to **6.x** for the foundation (stable, Better Auth adapter-proven); migration to 7 is a later, documented step.
- `Organization.markerLeadHours`, `Subscription.mappingStatus`, `Subscription.nextChargeDate` (date string) + `nextChargeAt`, `AutomationAction.{targetChargeDate,targetChargeAt,executeAfter,verifiedAt,fulfilledByCycleId}`, `IntegrationEvent.dispatchedAt`, `Exception.resolutionNote` added. `JourneyEndReason.PRODUCT_SWAP` → `PROGRAM_CHANGE` (+ `UNMAPPED`).
- Known risks accepted: a ≥72h outage would miss attachments (made loud by T-24h verification + `MARKER_MISSED`); Recharge "upcoming order" emails (~3 days out) may land before or after T-72h — `markerLeadHours` is the dial; Inngest free-tier concurrency is modest.

### Phase 1 — status (21 Aug 2026): **done**
- Repo `Narsyl/Reloop`, package `subscription-ops`; `.gitattributes`; `.env.example`.
- Prisma 6 schema + migrations `init`, `account_issuer` applied on Neon (Better Auth 1.7 requires `Account.issuer = "local:credential"`).
- `lib/crypto/credentials.ts` (AES-256-GCM, AAD-bound, key ring rotation) — 8 unit tests.
- Better Auth email+password; active organisation on `Session.activeOrganizationId`; `requireUser/requireOrg/requireRole`; onboarding creates org + OWNER.
- `dbFor(ctx)` org-scoped Prisma extension; ESLint guard on raw-client imports; cross-tenant test suite (16 tenant models × read/update/delete/count + scoped create) — 50 assertions.
- Design tokens (cool-biased neutrals, single slate-indigo accent, semantic status tones used only via `StatusBadge`), shadcn/Base UI primitives, composites (PageHeader, Metric, EmptyState, StatusBadge, DataTable-style tables, FilterBar (URL-synced), Pagination, Timeline/ActivityItem, DetailRow, ConfirmationDialog, RuleSummary, ExceptionCard, RuleRow).
- Shell: sidebar per §16, org switcher, user menu; pages: Overview, Subscriptions (server search/filter/paging), Subscription detail (journey timeline, actions, activity, external refs), Upcoming (date-grouped forecast), Rules (+ activate/disable with confirmation, detail, builder placeholder), Products (programs / products / markers tabs, unmapped banner), Activity, Exceptions (inbox with resolve/ignore), Settings (general form, team, integrations with capability panel); loading/error/not-found states.
- Inngest client + typed events + `/api/inngest` with a heartbeat function (dev mode verified).
- Seed: "Ancient Extracts Demo" (4 programs, 3 markers, 3 rules, 20 customers, 30 subscriptions incl. swapped/paused/cancelled/unmapped, planned/attached/fulfilled/failed actions, 3 exceptions, activity) + "Northwind Botanicals".
- Verified: typecheck, lint, 58 tests, production build, signed-in smoke test of all routes.
- Deferred to Phase 2: delete `lib/recharge.ts` + `app/api/recharge/*` once the connector exists; team invitations; rule builder (Phase 4).

## 22. Phase 2 — Recharge connector & read-only import (21 Aug 2026): **built, awaiting the real Ancient Extracts connection**

Constraints from the Phase 2 brief and how each is enforced:

| # | Constraint | Implementation |
|---|---|---|
| 1 | Program resolution returns 0 or 1 programs, never 2 | DB trigger `subscription_program_product_guard` (migration `phase2_sync_orders_mapping_guard`): a product has **either** one `*` mapping **or** variant-specific mappings, never both; per-(org, product) advisory lock serialises writers; `variantScope` must agree with `variantId`. Unique `(organizationId, productId, variantScope)` prevents duplicates. `buildProgramResolver()` still throws `AmbiguousProgramMappingError` defensively. `tests/integration/program-mapping.test.ts` covers all six requested cases + cross-tenant. UI (`AssignProductDialog`) disables the conflicting mode and explains why. |
| 2 | Read-only | Connector exposes **no** write functions in Phase 2 (`onetimes.ts` is list-only; `client.request` supports POST for later phases but nothing calls it). POC `lib/recharge.ts` and `app/api/recharge/*` **deleted**. `sync-idempotency.test` uses a fake connector with only list methods. |
| 3 | Per-organisation credentials | `lib/domain/integrations/connector.ts`: credentials selected explicitly from the Integration row, decrypted with AAD = integration id, passed to `RechargeClient`. No env fallback exists; `RechargeClient` throws without a token. |
| 4 | Empirical capabilities | `capabilities.ts`: GET `/token_information` (scopes) + GET `?limit=1` probes for store/customers/products/orders/subscriptions/onetimes/webhooks (+ charges optional). 401 aborts; 403/404 → `unavailable`. **Events/Credits/Customer sessions are reported from scopes only and never requested.** Connection succeeds iff the 7 required capabilities are available. |
| 5 | Idempotent, replayable sync | Every import is an upsert keyed by provider ids scoped to the integration: `(integrationId, externalProductId)`, `(productId, externalVariantId)`, `(integrationId, externalCustomerId)`, `(integrationId, externalSubscriptionId)`, `(integrationId, externalOrderId, externalSubscriptionId)`. Journey recalculation reconciles by `sequence` (ids stable). `tests/integration/sync-idempotency.test.ts` runs the pipeline repeatedly and after a partial run. |
| 6 | Persistent progress | `IntegrationSync` model: kind (INITIAL / INCREMENTAL / RECALCULATE_JOURNEYS), status, stage (CONNECTING → PRODUCTS → CUSTOMERS → SUBSCRIPTIONS → ORDERS → JOURNEYS → COMPLETE), per-stage `{cursor, pages, items, done}`, rolling counts, error, heartbeat. One Inngest step per page; cursor persisted after every page. UI shows stage list live (`SyncStatus`) and full history on the integration detail page. |
| 7 | Cycles from Recharge Orders | ORDERS stage walks `GET /orders?status=success` once, attributes subscription line items by `purchase_item_id` → `SubscriptionOrder` (one row per order × subscription). Journeys are computed from `SubscriptionOrder` only (`lib/domain/journeys/compute.ts`, pure + 12 unit tests). No charges, no customer order counts, no month arithmetic. |
| 8 | No journeys until mapped | `Subscription.mappingStatus = UNMAPPED`, `latestJourneyId = null` (renamed from `currentJourneyId` in Phase 3) when the current product/variant does not resolve; catalogue links (`productId/variantId`) are still set. |
| 9 | Bootstrap without programs | Connect → import → Products page shows imported products with **Unmapped** badges → `CreateProgramDialog` + `AssignProductDialog` → `journeys/recalculate.requested` → RECALCULATE_JOURNEYS run. |
| 10 | Raw vs normalised | Zod (`schemas.ts`, loose) → `mapper.ts` → DTOs (`lib/integrations/types.ts`). Restrained `providerData` on `Product`, `Subscription`, `SubscriptionOrder` only. |
| 11 | One client | `lib/integrations/recharge/client.ts`: auth/version headers, timeout, 429 + Retry-After, 5xx/network retry with jitter, `x-recharge-limit` awareness, redacted structured logging, correlation id, Zod validation, cursor pagination (filters only on first page). |
| 12 | Error taxonomy | `RechargeError.kind ∈ {AUTHENTICATION_ERROR, PERMISSION_ERROR, RATE_LIMITED, NOT_FOUND, VALIDATION_ERROR, REMOTE_SERVER_ERROR, NETWORK_ERROR, SCHEMA_ERROR, UNKNOWN}` with `retriable`; sync job maps terminal kinds → `NonRetriableError` + `FAILED` run. |
| 13 | No webhooks yet | `webhooks.ts` ships topics + HMAC verification (tested); no registration. |
| 14 | Operator UI | Integrations page (connect dialog with test → capability panel → save), integration detail (metrics: imported / mapped / unmapped / order lines; capabilities; latest run; **cycle audit sample**; sync history; external refs), Products (programs + mapping management), Subscriptions (mapping filter), Subscription detail (**Order history** table showing which order counted as which delivery). |

**Verification status:** typecheck, lint, 115 tests, production build, signed-in smoke test — all green. **Not yet done:** the real Ancient Extracts connection (requires the merchant token via the UI) and the manual cycle comparison against Recharge — the gate before Phase 3.

**Resolved before the live import (21 Aug 2026):** `sort_by=id-asc` on orders and `token_information.scopes` are confirmed by the current Recharge docs. External-ID shapes are now normalised in one place — `lib/integrations/recharge/ids.ts`: `"123"`, `123`, `{ ecommerce: "123" }`, `{ ecommerce: 123 }` (and bigint / very large numerics) → `"123"`; absent → `null`; malformed (`"null"`, `"undefined"`, booleans, non-integers, objects without `ecommerce`, nesting) → `ExternalIdError` (a `RechargeError` of kind `SCHEMA_ERROR`, non-retriable, naming resource/field/record). Schemas use `externalIdSchema` / `rechargeIdSchema`; the mapper enforces required-ness: subscription product+variant ids required; order subscription-line product+variant ids required; product/variant ids absent → skipped & counted (`productsSkipped`, `variantsSkipped`); one-time ids optional. Nothing downstream sees provider shapes. 38 unit tests in `tests/unit/external-ids.test.ts`.

**First live import — Ancient Extracts (Recharge store 208727), 21 Aug 2026: COMPLETED, zero errors.** 314 customers · 413 subscriptions (170 active / 243 cancelled) · 853 successful orders → 995 subscription order lines (3 unlinked: subscriptions Recharge no longer returns) · 1 existing one-time · 44 products / 73 variants (derived) · 413 journeys evaluated, all UNMAPPED until programs are created. Real-store findings fixed the same day: (a) `store.timezone` is an object `{iana_name,name}`; (b) `/token_information` returns `scopes` top-level, not wrapped; (c) `/products` → 422 "not compatible with your platform" on Shopify-checkout stores → capability `derived`, catalogue built from subscriptions + order lines (`deriveCatalogue`); (d) Recharge scope `read_accounts` is store accounts, not credits. Token scopes confirmed: `read_customers read_orders read_products read_subscriptions store_info write_subscriptions` (+ broader write scopes — recommend a narrower production token). Capabilities: subscriptions/one-times read_write, events & customer sessions unavailable, credits unavailable.

**Approved programme mappings (21 Aug 2026, applied through the normal pipeline):** Morning Magic Powder = 8848660857127 + 15077480857986 + 15349048213890 (all variants; Starter Kit checkout = cycle 1, starter-kit→main does not reset; whether a starter kit already includes a gift is a *rule/eligibility* question, not a journey question); Shilajit Resin = 8807821312295 (all variants; powder lineage, pairs, stacks excluded — pair→resin restarts at resin cycle 1 by design); Ceremonial Cacao Chunks = 14920529445250 + 15213214302594 + 15213215220098 (origin split does not reset; Collection Box excluded); Evening Elixir Mushroom Cacao = 15172321051010 (separate from chunks). Everything else UNMAPPED for validation. K-Cups absent from this (UK) store. Result: 231 mapped / 182 unmapped; 103 / 67 active; 233 journeys; 2 programme changes; 41 same-programme variant migrations; 0 exceptions.

**Live lifecycle validation — 14 real cases, Orders vs Recharge Charges (secondary, diagnostic only):** 866366070 new Shilajit = 1 (queued charge not counted) · 696880659 Morning Magic = 14 (14 charges) · 737740264 Morning Magic = 8 despite sibling Cordyceps/Lion's Mane lines on the same Recharge orders · 701425784 legacy Default→"1" = 11, no reset · 735805552 Starter Kit 5 + main 2 = **7**, one journey · 712686411 Morning Magic 10 → PROGRAM_CHANGE → Evening Elixir 1 (11 charges) · 707354745 cancelled, history kept = 10 · **861649121 active with a queued charge and zero successful charges = no cycle** (created ≠ delivered) · 775999528 Cacao Chunks → Peruvian split = 6, one journey · 849878775 two genuine successful charges on 2026-08-13 (Lion's Mane renewal + new Morning Magic after swap) — MM journey = 1, LM lines excluded as unmapped · 825045669 Shilajit 1 → Cacao 1 · 735782768 Pair 2 (excluded) + Resin **7** (charges 9) · **805925419 failed payment `RETRY_DECLINED` 2026-05-24 → stays 1** · 804400490 one delivery in four months, next charge 2026-08-31 → 1 (calendar time never advances cycles). 14/14 agree. **Decisions:** Charges are NOT persisted, NOT a sync stage, NOT a second engine — a read-only "Recharge verification" diagnostic (MATCH / MISMATCH — investigate) at most; Orders remain the durable historical source. Recharge-native `subscription_cycle_count_min` is **absent** from live 2021-11 Orders, line items, Charges and Subscriptions — no speculative field added.

**Live-import checklist (what the platform records):** products/variants (+skipped), customers, subscriptions (active / inactive by status), successful orders + order lines (+unlinked), journeys processed, mapped vs unmapped, sync stages + errors in `IntegrationSync`; one-times are read (not imported into a table in Phase 2 — listing is available for later reconciliation); cycle audit sample with exact Recharge order ids/dates on the integration page; per-subscription Order history table. Gate: 10/10 manual cycle audits (new, long-running, unrelated one-offs, same-program variant change, program swap, paused, skipped, failed payment, cancelled, one weird) agree with Recharge, then a re-run proves real-world idempotency.

## 23. Phase 3 — Automation configuration (21–23 Aug 2026): **done — rules & markers configurable and validated; no Recharge writes, no actions, activation unreachable**

Scope as approved (with the 14 amendments), what was built, and how each is enforced:

| # | Semantics | Implementation |
|---|---|---|
| 1 | `currentJourneyId` → **`latestJourneyId`** — the latest segment, never "actionable" | Renamed column/index/FK in migration `phase3_rules_markers_latest_journey`; recalc keeps ids stable; UI copy says "Latest journey". Actionability is a separate evaluation (row 2). |
| 2 | **Two-layer eligibility** | Layer A `lib/domain/eligibility/evaluate.ts` → `evaluateJourneyEligibility()` returns `{eligible:true}` or reason codes `SUBSCRIPTION_NOT_ACTIVE · NO_JOURNEY · NOT_LATEST_JOURNEY · JOURNEY_ENDED · UNMAPPED · BROKEN_MAPPING · NO_UPCOMING_CHARGE · INTEGRATION_NOT_CONNECTED · AUTOMATION_OFF · BLOCKING_EXCEPTION`. Layer B `qualify.ts` → `qualifyForRule()` returns timing `NOW / FUTURE / NEVER / BLOCKED` with `RULE_NOT_ACTIVE · WRONG_PROGRAM · MILESTONE_ALREADY_PASSED · NOT_NEXT_CYCLE · SCOPE_NOT_CHOSEN · CUSTOMER_ALREADY_REACHED_MILESTONE · ACTION_EXISTS`. Pure, unit-tested (`tests/unit/eligibility.test.ts`). |
| 3 | **V1 milestone uniqueness** = organisation + programme + cycle; the rule chooses the marker; archiving frees the milestone | `AutomationRule.milestoneKey` (`org:program:cycle`) `@unique`, nulled on ARCHIVED; friendly error on conflict ("one milestone rule per programme + cycle"). |
| 4 | **Marker identity = external variant id, scoped to one integration**; SKU/title are verification only | `FulfillmentMarker.integrationId` (NOT NULL, backfilled variant→product→integration), `externalVariantId`, optional `externalProductId`/`title`/`sku`, `source ∈ {MANUAL, CATALOGUE, DISCOVERED_ONETIME}`, `@@unique([integrationId, externalVariantId])`, `variantId @unique`. Rules may only reference a marker from the programme's integration. |
| 5 | **Read-only discovery** of existing one-times to pre-fill markers | `discoverMarkersFromOnetimes()` lists `GET /onetimes` through the existing connector (variant, product, title, SKU, price, occurrences, last seen, already-configured). Nothing is written; the operator still reviews and saves. |
| 6 | **Eligibility scope is explicit** — `PER_SUBSCRIPTION` vs `CUSTOMER_PROGRAM`, no default | `AutomationRule.eligibilityScope` nullable; READY is refused until chosen; the builder shows **both** counts side by side from real data before asking. |
| 7 | **Lifetime deliveries from distinct cycle evidence**, not summed counters | `analyzeMilestoneImpact()` counts distinct `JourneyCycle` rows per customer + programme across all journeys (cancelled + new + simultaneous). Test deliberately corrupts `successfulCycles` and proves lifetime is unaffected; twin simultaneous subscriptions tested. |
| 8 | **Cycle ≥ 2** | DB `CHECK ("cycleNumber" >= 2)`, Zod, UI hint, explanation "Delivery 1 occurs at subscription checkout, before milestone automation can schedule an upcoming shipment. Milestone rules begin at delivery 2." |
| 9 | No invented PAUSED | `schedulingState()` → "Active · No upcoming charge" badge on list + detail; impact bucket `NO_UPCOMING_CHARGE`. |
| 10 | **`startedAt` correction** without changing cycle identity | A journey starts at the first counted delivery that opens it; it inherits the subscription's creation time only when that delivery is the subscription's very first order (checkout precedes processing). Journeys opened after unmapped history (swap from an excluded product) start at their own first delivery. Live recalc: all 233 journeys identical in cycles/orders/`latestJourneyId`; exactly 3 `startedAt` values moved — **849878775 → 2026-08-13**, 735782768 → 2026-02-05 (pair history before the resin), 734118870 → 2026-03-15. |
| 11 | **Scheduled incremental read-only sync** | Inngest cron `15 */4 * * *` (`lib/jobs/functions/incremental.ts`) creates `INCREMENTAL` runs with `updatedSince = lastSuccessfulSyncAt − 10 min` (overlap is harmless: everything is an upsert), dispatches `integration/sync.requested`, skips integrations with a run in flight and — new — integrations whose credentials cannot be decrypted on this host (`hasDecryptionKeyFor`), so seed placeholders / rotated-out keys never create failing runs. |
| 12 | **Active-unmapped exceptions with noise control** | `UNMAPPED` stays informational (badge/count); a MAPPED→UNMAPPED transition on an active subscription opens one `MAPPING_BROKEN` WARNING exception (deduped while open, auto-resolved when mapped again). |
| 13 | Rule lifecycle `DRAFT → READY → (ACTIVE) → DISABLED → ARCHIVED`, **ACTIVE unreachable** | `setRuleStatus` refuses ACTIVE server-side ("Activation is not available yet…"); READY requires scope + active programme + active marker; editing a READY rule returns it to DRAFT; markers used by READY/ACTIVE rules cannot be deactivated. No `AutomationAction` row can be created by any Phase 3 path (count on Ancient Extracts: **0**). |
| 14 | One external one-time per AutomationAction / prepaid = per shipment order | Design only (Phase 4/6); prepaid fixture in `tests/unit/mapper.test.ts`. |

**UI:** `/rules` (list with status, scope, milestone, marker, Mark Ready / Disable / Archive), `/rules/new` (4-step builder: programme → delivery → marker → who counts, with the live impact panel), `/rules/[id]` (impact + `?edit=1`), Products → Markers tab (`MarkerDialog` with read-only discovery, activate/deactivate), subscription list/detail scheduling badge.

**Live validation on Ancient Extracts (read-only throughout — the connector's only reachable verb is GET: `client.request()` has no caller other than `client.get()`):**

- Recalculation run COMPLETED; fingerprint diff as in row 10; 0 `MAPPING_BROKEN` exceptions.
- Incremental runs: 21 Aug 20:37 (manual, 0 deltas, journeys recomputed identically) · **22 Aug 00:15 fired by the cron on its own** (COMPLETED, 252 s) · 22 Aug 06:50 (cron after machine wake; 6 subscriptions / 4 orders; 10.7 h wall-clock because the laptop slept mid-run — completed correctly when it resumed) · **23 Aug 14:06: 5 subscriptions, 4 orders, 5 customers updated; 2 new Morning Magic journeys (868352796, 868223347), 735782768 advanced 7 → 8, 728983928 charged and now "No upcoming charge"; 236 journeys; 0 actions.** Two cron failures explained: 21 Aug 20:15 on Ancient Extracts hit the Phase 3 migration window (`currentJourneyId` no longer existed while the old client was loaded — transient, every later run succeeded); the demo organisations' placeholder credentials failed at CONNECTING each slot → fixed by row 11's guard.
- Configuration through the real server actions: discovery found **one** one-time in the store — a paid £12.99 "Ceremonial Grade Venezuelan Cacao Chunks" add-on scheduled for 2026-08-22 (variant 56259577545090) — **there is no £0 "Morning Magic 2" item in Recharge yet**. A marker was saved from discovery and honestly named `PLACEHOLDER (Cacao Chunks one-time) — replace with £0 Morning Magic 2`; rule **"Morning Magic Powder · delivery 2"** saved as DRAFT (scope deliberately not chosen — see impact). Guards exercised live: cycle 1 refused with the explanation; duplicate milestone refused; READY without scope refused; ACTIVE refused; marker deactivate/reactivate allowed only while no READY rule uses it.

**Morning Magic Powder · delivery 2 — impact on real data (23 Aug 2026, after the incremental):** 79 subscriptions in programme · 36 active · 25 currently at delivery 1. Buckets: would qualify now **7** (Alexandria Pitts, Tracy Jamieson, Tas Brooker, Andreea Istrate, Janet Lee, Ewa Wojdak, Jill Macleod — all cycle 1, lifetime 1, next charge 28 Aug–24 Sep) · future only 1 · already past 26 · no upcoming charge 2 (Chafik Hammas at cycle 1 would qualify the moment a charge is scheduled; Karen Jaques already past) · cancelled/inactive 43 · unmapped/broken 0. **PER_SUBSCRIPTION: 7 now, 1 future. CUSTOMER_PROGRAM: 7 now, 0 future, 1 "already reached via an earlier subscription".** The single live disagreement is **Stuart Wiseglass** — new subscription 861649121 at cycle 0 (lifetime 3 from cancelled 822300881): per-subscription he gets the delivery-2 marker again on his new subscription; customer-programme says the milestone was reached long ago. Other returning customers (Danielle Hayter lifetime 12 — cancelled 10 + new 2 —, Karen Jaques 8, Charlotte Groom 8, Pat Corby 2) are already past delivery 2 under both scopes, so for *this* milestone the two scopes only diverge for Stuart; for later milestones (e.g. delivery 12) they diverge for Danielle. Two days earlier (21 Aug) the same analysis read 8 / 8 / 0 future — Clair Deane's 22 Aug charge moved her to "already past" (a delivery-2 marker missed, as expected with automation off), which the incremental picked up.

**Verification:** typecheck, lint, **192 tests**, production build, signed-in smoke test of every new page with the real configuration — all green.

**Still not done (Phase 4 gates, unchanged):** no `POST /onetimes`, no `AutomationAction` planning, no D6 scheduled action creation, no execution, no Recharge webhooks, no automatic marker reconciliation, no marker removal/moving, no fulfilment backfill, no Royal Mail, no live rules, no customer notifications. Before the delivery-2 rule can be marked Ready the merchant must create the real £0 "Morning Magic 2" variant in Shopify, enter it as the marker, and choose the scope.

### 23 Aug 2026 — dev database incident and recovery (between Phase 3 and Phase 4)

A `prisma migrate diff` drafting the Phase 4 migration was given the real `DATABASE_URL` as its *shadow* database by a shell fallback; Prisma's shadow procedure reset the Neon dev database (~14:30 UTC). Recovery: Neon point-in-time restore of branch `main` to **2026-08-23T14:23:14Z** (after the Phase 3 commit and last incremental sync, before the wipe), verified first on temporary time-travel branches, then `prisma migrate deploy` (Phase 4 migration) and `npm run db:integrity` → OK: original organisation id, 415 subscriptions / 234 mapped, 1004 order lines, 236 journeys, 590 cycles, 4 programmes / 8 mappings, rule + marker, 9 AE sync runs, 29 activity rows, credentials decrypt, 0 actions, no duplicate natural keys. A read-only incremental catch-up found zero provider changes. Hardening (committed): `scripts/db/safe-prisma.mjs` (fail-closed shadow validation; the only sanctioned entry for shadow/destructive-capable Prisma operations), `npm run db:*` scripts, `docs/DB-MIGRATIONS.md`, `.claude/settings.json` deny rules + PreToolUse guard hook, `scripts/db/integrity-check.ts`.

## 24. Phase 4 — Action engine: planning + DRY_RUN (23 Aug 2026): **built and validated; still no Recharge writes; LIVE unreachable**

Goal proven: *correct lifecycle + correct rule + correct target shipment → exactly one internally-owned PLANNED action → correct executeAfter → a dry run that says exactly what we WOULD send to Recharge, without sending it.*

| # | Requirement | Implementation |
|---|---|---|
| 1 | Planning on cycle N−1 | `lib/domain/actions/planner.ts` `planActionsForIntegration()`: READY/ACTIVE rules × `loadProgramPopulation()` (the **same** loader the impact analysis uses, so preview and planner populations are identical) × layer A eligibility × layer B qualification with the rule's scope → PLANNED action with `targetCycle`, `targetChargeDate` (the subscription's exact provider date), `targetChargeAt` (local midnight, org timezone), `executeAfter = targetChargeAt − markerLeadHours` (clamped to now inside the window). `dryRun=true` whenever the mode is not LIVE. |
| 2 | Idempotency — DB-level | `liveKey` (`journey:cycle:marker`, §10) **and** `ownerKey` (scope owner: `j:<journey>:<cycle>:<marker>` or `c:<customer>:<programme>:<cycle>:<marker>`), both UNIQUE while live, nulled only by `transitionAction()` (CANCELLED/SUPERSEDED) — the single status writer. The planner creates and lets the database arbitrate (P2002 → "already owned"); a cheap pre-check avoids routine violations but is not relied on. Tested: repeated runs, 5 concurrent runs, sync+recalc then planner — one action, no duplicates. |
| 3 | CUSTOMER_PROGRAM re-evaluation | The planner never plans from `successfulCycles` alone: lifetime deliveries from distinct `JourneyCycle` evidence feed `qualifyForRule()`. Regression tests: Stuart shape (new sub, earlier history crossed cycle 2) → no action; returning customer at cycle 1 with lifetime 2 → no action; twins → no action. |
| 4 | Target charge | `targetChargeDate` = `Subscription.nextChargeDate` (the subscription's own `next_charge_scheduled_at`), never a customer/address date; `targetChargeAt` per D6; `externalAddressId` stored on the action. |
| 5 | Lead time | `Organization.markerLeadHours` (AE 72 h): target 28 Aug → `executeAfter` 25 Aug 00:00 Europe/London (24 Aug 23:00Z). Unit-tested for BST, GMT, New York, inside-window clamp, other lead values. |
| 6 | Replanning | Same action, in place: target charge moved → dates recomputed, `replanCount++`, dry-run state reset. Cancelled with a recorded reason: subscription not active, no upcoming charge, journey ended / programme changed, mapping broken, rule no longer Ready (incl. scope removed), marker inactive/placeholder, customer already reached the milestone, `MILESTONE_PASSED` (target delivery processed without the marker — the dry-run "miss"), no longer qualifies. `SUPERSEDED` (+`supersededById`) when the rule's marker changes. All covered by `tests/integration/planner.test.ts`. |
| 7 | DRY_RUN executor | `lib/domain/actions/dry-run.ts` `dryRunAction()`: fresh internal state (mode, rule, marker, eligibility + scope via the shared population) + **read-only** provider state (`GET /subscriptions/{id}`, `GET /onetimes?address_id=`) → `DryRunResult` with customer, subscription, programme, journey cycles, rule, scope, target cycle/date/at, execute-after, marker title/SKU/variant, Recharge address id, **Would execute? YES/NO**, blocking reason/detail, and the exact intended operation `POST /onetimes { address_id, next_charge_scheduled_at, external_variant_id:{ecommerce}, external_product_id?, product_title, quantity 1, price "0.00", properties[_subscription_ops_action] }` with `sent:false`. Detects a pre-existing identical one-time → `ADOPT_EXISTING_ONETIME` (§10 external gate). Stored on the action (`dryRunJson`, `wouldExecute`, `blockingReason`, `lastDryRunAt`) + activity row. |
| 8 | Population for validation | Recomputed from current state every run — nothing hard-coded. Test proves `planner decisions (PLANNED) == impact analysis "would qualify now" under the rule's scope`. |
| 9 | Upcoming | `/upcoming` runs on real `AutomationAction` rows: customer, programme, target delivery, marker, target charge, planned execution, status, eligibility/risk (dry-run state), per-store automation mode + last planner run, planner-run history; `/upcoming/[id]` shows the full plan, the dry-run verdict, external state and the intended operation, with "Dry run now". |
| 10 | Automation modes | `setIntegrationAutomationMode()`: OFF / DRY_RUN reachable; **LIVE refused server-side**; UI control on the integration page (Live shown locked). Defence in depth: `RechargeClient.request` is now private — `get`/`paginate` (GET) are the only public verbs; no code path can POST. Ancient Extracts is DRY_RUN. |
| 11 | READY semantics | READY = configuration valid and **used by the dry-run planner**; refused when the marker is a placeholder; ACTIVE still refused. |
| 12 | Webhooks | Not built. Planning is driven by the read-only sync: every completed run dispatches `automation/plan.requested` when the mode is not OFF; cron `*/30 * * * *` dry-runs due actions (`executeAfter ≤ now`, not dry-run since planning). |

**Jobs:** `automation-plan-actions` (serialised + debounced per integration), `automation-dry-run-due` (cron). **Schema:** `FulfillmentMarker.placeholder`; `AutomationAction.ownerKey / eligibilityScope / plannerRunId / lastPlannedAt / replanCount / supersededById / lastDryRunAt / dryRunJson / wouldExecute / blockingReason`; `PlannerRun`. Markers: identity change is audited (`MARKER_IDENTITY_CHANGED` with previous values), refused while attached actions exist, orphaned internal catalogue rows removed.

**Live state on Ancient Extracts (23 Aug 2026):** integration **DRY_RUN**; rule "Morning Magic Powder · delivery 2" **CUSTOMER_PROGRAM, DRAFT**; the Cacao marker is flagged **placeholder** (READY refused with the explanation; planner run: `NO_USABLE_RULES`, 0 actions). The real £0 "Morning Magic 2" Shopify variant is the gate: replace the placeholder, mark READY, and the next planner run (post-sync or manual) creates the delivery-2 actions for the currently qualifying population — 7 customers as of the 23 Aug analysis, recomputed at run time — each dry-run against live Recharge reads. Demo organisation exercised end-to-end (5 planned, 3 held by existing attached/failed actions, idempotent re-run, dry-run blocked on the seed credentials while still showing the intended payload).

**Verification:** typecheck, lint, full test suite (planner/dry-run integration tests + schedule/keys unit tests added), production build, signed-in smoke tests (Upcoming, action detail, integration automation panel, placeholder badge), cross-tenant action URL returns not-found. Recharge traffic remains GET-only (connector has no reachable write).

**DoD items that remain open until the real marker exists:** #1 real marker configured, #3 rule READY, and the real-population planned-actions/dry-run report — executed immediately once the variant id is provided. **Still not done, by design:** LIVE execution, webhooks (Phase 5), marker reconciliation/removal, fulfilment backfill, Royal Mail, customer notifications.

## 25. Phase 4b — Reward schedules (23 Aug 2026): **implemented; configuration abstraction for the planner; still zero Recharge writes**

Approved amendments to the proposal in `docs/REWARD-SCHEDULES.md` were all adopted: **no platform gift enum** — organisation-owned `RewardItem`; milestones reference `rewardItemId`; markers reference `rewardItemId` + `operationalNote`; bindings reference the milestone explicitly (`ProgramMilestoneMarker(programId, rewardScheduleMilestoneId, fulfillmentMarkerId)`, unique per programme + milestone); `SubscriptionProgram.rewardScheduleId` (one schedule per programme); rules retired as authored configuration (legacy, read-only, migrated with `RULE_MIGRATED_TO_SCHEDULE`); `INITIAL_CHECKOUT` milestones recorded and never planned (`INITIAL_CHECKOUT_NOT_PLANNED`); CUSTOMER_PROGRAM on every early milestone; reward once per **programme** (no `CUSTOMER_SCHEDULE`).

| Piece | Implementation |
|---|---|
| Schema (migration `phase4b_reward_schedules`, additive) | `RewardItem`, `RewardSchedule` (DRAFT/READY/ARCHIVED), `RewardScheduleMilestone` (cycle, rewardItem, executionMode, eligibilityScope required, active; unique schedule×cycle; DB CHECK `cycle = 1 ⇔ INITIAL_CHECKOUT`), `ProgramMilestoneMarker`; `SubscriptionProgram.rewardScheduleId/rewardScheduleAssignedAt`; `FulfillmentMarker.rewardItemId/operationalNote`; `AutomationAction.rewardScheduleMilestoneId/programId`; `AutomationRule.migratedToMilestoneId`; `EntityType` + REWARD_SCHEDULE/REWARD_ITEM. All four new models are tenant models (cross-tenant tests). |
| Resolver | `lib/domain/rewards/resolver.ts` `resolveProgramRewards()` → effective milestones with computed readiness: `READY` or `SCHEDULE_NOT_READY / SCHEDULE_ARCHIVED / MILESTONE_INACTIVE / INITIAL_CHECKOUT_NOT_PLANNED / BINDING_MISSING / BINDING_INACTIVE / MARKER_INACTIVE / MARKER_PLACEHOLDER / MARKER_REWARD_MISMATCH / MARKER_OTHER_INTEGRATION / PROGRAM_INACTIVE`. |
| Planner | Consumes effective milestones (`planActionsForIntegration` unchanged in its action/idempotency semantics: liveKey + ownerKey, create-or-conflict, in-place replanning, `transitionAction` as the only status writer). New reconcile reasons: `RULE_RETIRED`, `SCHEDULE_NOT_READY`, `MILESTONE_INACTIVE`, `MILESTONE_NOT_ASSIGNED`, `BINDING_MISSING`; `BINDING_CHANGED` → SUPERSEDED. Run summary reports `milestonesSkipped` per programme with reasons. |
| Dry run | Preview includes `milestone {schedule, delivery, reward item, scope, mode, readiness}`; blocks `MILESTONE_NOT_READY:<reason>` / `MILESTONE_NOT_ASSIGNED`. |
| Configuration core + actions | `lib/domain/rewards/core.ts` (audited): reward items, schedules, milestones (mode derived from delivery number), status, programme assignment, marker binding (validated: programme on the milestone's schedule, marker in the programme's store, marker names the milestone's reward item), legacy rule migration. Server actions in `lib/domain/rewards/actions.ts`. |
| UI | `/rewards` (schedules + reward items), `/rewards/[id]` (milestones, programme assignment, per-programme marker bindings with readiness + live impact per cell, missing bindings), markers carry reward item + note, Upcoming/action detail show schedule · delivery → reward, rules pages are legacy (no new rules; `/rules/new` redirects). Sidebar: Rewards. |
| Tests | `tests/integration/planner.test.ts` rewritten on schedules (+ per-programme reward across a shared schedule, INITIAL_CHECKOUT never planned, customer-level owner key across twin journeys, schedule swap keeps keys, binding change supersedes, schedule → DRAFT cancels, placeholder binding never planned, dry-run shows milestone/reward); `tests/integration/reward-schedules.test.ts` (constraints, CHECK, reward-item tenancy, binding validations, rule migration keeps audit rows); tenant-isolation covers the 4 new models. |

**Ancient Extracts — applied 23 Aug 2026 (lifecycle fingerprint identical after the schema + configuration steps; only the approved new mappings added journeys):**

- Reward items: Whisk, Cup, Spoon. Schedule A "Mushroom / Matcha / Soursop": 2 → Whisk, 3 → Cup. Schedule B "Morning Magic / Evening Elixir": 1 → Whisk (INITIAL_CHECKOUT), 2 → Cup, 3 → Spoon. All CUSTOMER_PROGRAM. Both READY (configuration approved; nothing plannable until real markers are bound).
- Assigned: Morning Magic Powder + Evening Elixir → B; 11 new programmes → A: Chaga (8525211009319), Cordyceps (8525213040935), Lion's Mane (8525215334695), Reishi (8525215007015), Tremella (9569100300583), Ceremonial Grade Matcha (14920527020418 + 15259499266434, continuous), Butterfly Pea (15191093936514 only), Hibiscus (15191097115010), Ube (15191096623490), Pitaya Dragon Fruit (15191096328578), Soursop (15036118761858 + 15259503165826, continuous). Hojicha: documented only (no catalogue product). Excluded: pairs, stacks, collection/box bundles, Indulgent Pair, Ritual Grade Matcha Bundle, Am & Pm Ritual, Digestive+ Stack, pets, Turkey Tail, Shilajit Powder.
- Legacy rule "Morning Magic Powder · delivery 2" ARCHIVED → Schedule B delivery 2 (Cup); placeholder marker keeps `placeholder=true`, now `rewardItem=Cup`, bound to MM × B2 (readiness MARKER_PLACEHOLDER).
- Mapping effect on lifecycle: 121 subscriptions UNMAPPED→MAPPED, +13 mappings, +125 journeys, +281 cycles, orders unchanged; one pre-existing journey re-segmented — 849878775 (Tas Brooker): Lion's Mane #1 (2 cycles: 2026-07-16, 2026-08-13) → PROGRAM_CHANGE → Morning Magic #2 (1 cycle, 2026-08-13) — the documented swap, now with its LM history recognised. 355 mapped / 60 unmapped (21 active unmapped, all excluded families). Programme changes 2 → 5.
- Planner run (DRY_RUN): `NO_PLANNABLE_MILESTONES` — 13 programmes, 28 effective milestones: 25 BINDING_MISSING, 2 INITIAL_CHECKOUT_NOT_PLANNED (MM d1, EE d1), 1 MARKER_PLACEHOLDER (MM d2). **0 actions.** Gate: create the real £0 markers per programme/delivery and bind them (each marker named with its reward item).

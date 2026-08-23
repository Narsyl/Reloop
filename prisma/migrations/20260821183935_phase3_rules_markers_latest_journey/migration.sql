-- Phase 3 — Automation Configuration (hand-authored: renames + backfills, no data loss)

-- CreateEnum
CREATE TYPE "MarkerSource" AS ENUM ('MANUAL', 'CATALOGUE', 'DISCOVERED_ONETIME');
CREATE TYPE "RuleStatus" AS ENUM ('DRAFT', 'READY', 'ACTIVE', 'DISABLED', 'ARCHIVED');
CREATE TYPE "EligibilityScope" AS ENUM ('PER_SUBSCRIPTION', 'CUSTOMER_PROGRAM');

-- ── Subscription.currentJourneyId → latestJourneyId (true rename; ids/data untouched) ──
ALTER TABLE "Subscription" RENAME COLUMN "currentJourneyId" TO "latestJourneyId";
ALTER INDEX "Subscription_currentJourneyId_key" RENAME TO "Subscription_latestJourneyId_key";
ALTER TABLE "Subscription" RENAME CONSTRAINT "Subscription_currentJourneyId_fkey" TO "Subscription_latestJourneyId_fkey";

-- ── AutomationRule: enabled → status, eligibilityScope, milestoneKey ──
ALTER TABLE "AutomationRule"
  ADD COLUMN "eligibilityScope" "EligibilityScope",
  ADD COLUMN "milestoneKey" TEXT,
  ADD COLUMN "status" "RuleStatus" NOT NULL DEFAULT 'DRAFT';
-- existing rules: enabled → READY (never ACTIVE before the action engine exists), disabled → DRAFT
UPDATE "AutomationRule" SET "status" = CASE WHEN "enabled" THEN 'READY'::"RuleStatus" ELSE 'DRAFT'::"RuleStatus" END;
UPDATE "AutomationRule" SET "milestoneKey" = "organizationId" || ':' || "programId" || ':' || "cycleNumber";
ALTER TABLE "AutomationRule" DROP COLUMN "enabled";
DROP INDEX IF EXISTS "AutomationRule_organizationId_enabled_programId_cycleNumber_idx";
CREATE UNIQUE INDEX "AutomationRule_milestoneKey_key" ON "AutomationRule"("milestoneKey");
CREATE INDEX "AutomationRule_organizationId_status_programId_cycleNumber_idx" ON "AutomationRule"("organizationId", "status", "programId", "cycleNumber");
-- Delivery 1 is the checkout order: milestone rules start at delivery 2 (also enforced in the domain layer).
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_cycleNumber_min_check" CHECK ("cycleNumber" >= 2);

-- ── FulfillmentMarker: integration-scoped external identity ──
ALTER TABLE "FulfillmentMarker"
  ADD COLUMN "externalProductId" TEXT,
  ADD COLUMN "externalVariantId" TEXT,
  ADD COLUMN "integrationId" TEXT,
  ADD COLUMN "sku" TEXT,
  ADD COLUMN "source" "MarkerSource" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "title" TEXT;
-- backfill from the referenced variant → product → integration
UPDATE "FulfillmentMarker" m
   SET "integrationId" = p."integrationId",
       "externalVariantId" = v."externalVariantId",
       "externalProductId" = p."externalProductId",
       "sku" = v."sku",
       "title" = p."title",
       "source" = 'CATALOGUE'
  FROM "ProductVariant" v JOIN "Product" p ON p."id" = v."productId"
 WHERE v."id" = m."variantId";
ALTER TABLE "FulfillmentMarker" ALTER COLUMN "integrationId" SET NOT NULL;
ALTER TABLE "FulfillmentMarker" ALTER COLUMN "externalVariantId" SET NOT NULL;
CREATE UNIQUE INDEX "FulfillmentMarker_variantId_key" ON "FulfillmentMarker"("variantId");
CREATE UNIQUE INDEX "FulfillmentMarker_integrationId_externalVariantId_key" ON "FulfillmentMarker"("integrationId", "externalVariantId");
ALTER TABLE "FulfillmentMarker" ADD CONSTRAINT "FulfillmentMarker_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

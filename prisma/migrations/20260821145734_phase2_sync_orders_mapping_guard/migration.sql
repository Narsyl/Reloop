-- CreateEnum
CREATE TYPE "SyncKind" AS ENUM ('INITIAL', 'INCREMENTAL', 'RECALCULATE_JOURNEYS');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SyncStage" AS ENUM ('CONNECTING', 'PRODUCTS', 'CUSTOMERS', 'SUBSCRIPTIONS', 'ORDERS', 'JOURNEYS', 'COMPLETE');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "providerData" JSONB;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "providerData" JSONB;

-- CreateTable
CREATE TABLE "IntegrationSync" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "kind" "SyncKind" NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'QUEUED',
    "stage" "SyncStage" NOT NULL DEFAULT 'CONNECTING',
    "triggeredById" TEXT,
    "inngestRunId" TEXT,
    "updatedSince" TIMESTAMP(3),
    "progressJson" JSONB,
    "countsJson" JSONB,
    "error" TEXT,
    "lastHeartbeatAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationSync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionOrder" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "externalSubscriptionId" TEXT NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "externalChargeId" TEXT,
    "externalCustomerId" TEXT,
    "externalAddressId" TEXT,
    "orderKind" "OrderKind" NOT NULL,
    "orderStatus" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL,
    "externalProductId" TEXT NOT NULL,
    "externalVariantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "productTitle" TEXT,
    "providerData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntegrationSync_integrationId_createdAt_idx" ON "IntegrationSync"("integrationId", "createdAt");

-- CreateIndex
CREATE INDEX "IntegrationSync_organizationId_status_idx" ON "IntegrationSync"("organizationId", "status");

-- CreateIndex
CREATE INDEX "SubscriptionOrder_subscriptionId_processedAt_idx" ON "SubscriptionOrder"("subscriptionId", "processedAt");

-- CreateIndex
CREATE INDEX "SubscriptionOrder_integrationId_externalSubscriptionId_proc_idx" ON "SubscriptionOrder"("integrationId", "externalSubscriptionId", "processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionOrder_integrationId_externalOrderId_externalSub_key" ON "SubscriptionOrder"("integrationId", "externalOrderId", "externalSubscriptionId");

-- AddForeignKey
ALTER TABLE "IntegrationSync" ADD CONSTRAINT "IntegrationSync_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationSync" ADD CONSTRAINT "IntegrationSync_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionOrder" ADD CONSTRAINT "SubscriptionOrder_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionOrder" ADD CONSTRAINT "SubscriptionOrder_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionOrder" ADD CONSTRAINT "SubscriptionOrder_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Program-mapping ambiguity guard (ARCHITECTURE.md §21 / Phase 2 constraint 1)
--
-- Invariant: for any (organizationId, productId), EITHER exactly one "*" (all
-- variants) mapping exists, OR any number of variant-specific mappings exist —
-- never both. Combined with the unique index on (organizationId, productId,
-- variantScope), program resolution for any product/variant returns 0 or 1 rows.
--
-- A per-product transaction advisory lock serialises concurrent writers so two
-- transactions cannot each pass the check before the other commits.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION subscription_program_product_guard() RETURNS trigger AS $$
DECLARE
  conflict_count integer;
BEGIN
  -- serialise per (organizationId, productId)
  PERFORM pg_advisory_xact_lock(hashtext(NEW."organizationId" || ':' || NEW."productId"));

  IF NEW."variantScope" = '*' THEN
    SELECT count(*) INTO conflict_count
      FROM "SubscriptionProgramProduct"
     WHERE "organizationId" = NEW."organizationId"
       AND "productId" = NEW."productId"
       AND "variantScope" <> '*'
       AND "id" <> NEW."id";
    IF conflict_count > 0 THEN
      RAISE EXCEPTION 'PROGRAM_MAPPING_AMBIGUOUS: product % already has % variant-specific mapping(s); remove them before mapping all variants',
        NEW."productId", conflict_count USING ERRCODE = '23P01';
    END IF;
  ELSE
    SELECT count(*) INTO conflict_count
      FROM "SubscriptionProgramProduct"
     WHERE "organizationId" = NEW."organizationId"
       AND "productId" = NEW."productId"
       AND "variantScope" = '*'
       AND "id" <> NEW."id";
    IF conflict_count > 0 THEN
      RAISE EXCEPTION 'PROGRAM_MAPPING_AMBIGUOUS: product % is already mapped for all variants; remove that mapping before mapping a specific variant',
        NEW."productId" USING ERRCODE = '23P01';
    END IF;
  END IF;

  -- variantScope must agree with variantId
  IF (NEW."variantId" IS NULL AND NEW."variantScope" <> '*') OR (NEW."variantId" IS NOT NULL AND NEW."variantScope" <> NEW."variantId") THEN
    RAISE EXCEPTION 'PROGRAM_MAPPING_INVALID: variantScope must be ''*'' when variantId is null, or equal to variantId'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS subscription_program_product_guard_trg ON "SubscriptionProgramProduct";
CREATE TRIGGER subscription_program_product_guard_trg
  BEFORE INSERT OR UPDATE ON "SubscriptionProgramProduct"
  FOR EACH ROW EXECUTE FUNCTION subscription_program_product_guard();

-- Phase 7: trial conversion (sachet → pouch) — funnels + per-subscription candidates.
-- Additive only.

-- CreateEnum
CREATE TYPE "TrialConversionMode" AS ENUM ('OFF', 'DRY_RUN', 'LIVE');

-- CreateEnum
CREATE TYPE "TrialCandidateStatus" AS ENUM ('WATCHING', 'CONVERTING', 'CONVERTED', 'WOULD_CONVERT', 'CANCELLED', 'ALREADY_CONVERTED', 'ENDED', 'FAILED', 'UNCERTAIN');

-- CreateTable
CREATE TABLE "TrialConversionFunnel" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "TrialConversionMode" NOT NULL DEFAULT 'OFF',
    "sourceExternalProductId" TEXT NOT NULL,
    "targetExternalProductId" TEXT NOT NULL,
    "targetExternalVariantId" TEXT NOT NULL,
    "targetProductTitle" TEXT,
    "targetPrice" DECIMAL(10,2),
    "targetIntervalUnit" TEXT,
    "targetIntervalFrequency" INTEGER,
    "targetChargeIntervalFrequency" INTEGER,
    "convertAfterDays" INTEGER NOT NULL DEFAULT 7,
    "checkpointDays" INTEGER[] DEFAULT ARRAY[2, 5, 6, 7]::INTEGER[],
    "enrollFrom" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrialConversionFunnel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrialConversionCandidate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "funnelId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "externalSubscriptionId" TEXT NOT NULL,
    "status" "TrialCandidateStatus" NOT NULL DEFAULT 'WATCHING',
    "trialStartedAt" TIMESTAMP(3) NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "checkpointsJson" JSONB,
    "lastCheckedAt" TIMESTAMP(3),
    "lastProviderStatus" TEXT,
    "detail" TEXT,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "convertedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrialConversionCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrialConversionFunnel_organizationId_idx" ON "TrialConversionFunnel"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "TrialConversionFunnel_integrationId_sourceExternalProductId_key" ON "TrialConversionFunnel"("integrationId", "sourceExternalProductId");

-- CreateIndex
CREATE INDEX "TrialConversionCandidate_organizationId_status_idx" ON "TrialConversionCandidate"("organizationId", "status");

-- CreateIndex
CREATE INDEX "TrialConversionCandidate_funnelId_status_dueAt_idx" ON "TrialConversionCandidate"("funnelId", "status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrialConversionCandidate_funnelId_subscriptionId_key" ON "TrialConversionCandidate"("funnelId", "subscriptionId");

-- AddForeignKey
ALTER TABLE "TrialConversionFunnel" ADD CONSTRAINT "TrialConversionFunnel_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrialConversionFunnel" ADD CONSTRAINT "TrialConversionFunnel_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrialConversionCandidate" ADD CONSTRAINT "TrialConversionCandidate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrialConversionCandidate" ADD CONSTRAINT "TrialConversionCandidate_funnelId_fkey" FOREIGN KEY ("funnelId") REFERENCES "TrialConversionFunnel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrialConversionCandidate" ADD CONSTRAINT "TrialConversionCandidate_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

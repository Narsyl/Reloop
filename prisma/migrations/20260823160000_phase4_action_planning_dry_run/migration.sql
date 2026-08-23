-- Phase 4: action planning + DRY_RUN executor (no Recharge writes).

-- CreateEnum
CREATE TYPE "PlannerRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- AlterTable: planning / dry-run fields on AutomationAction
ALTER TABLE "AutomationAction" ADD COLUMN     "blockingReason" TEXT,
ADD COLUMN     "dryRunJson" JSONB,
ADD COLUMN     "eligibilityScope" "EligibilityScope",
ADD COLUMN     "lastDryRunAt" TIMESTAMP(3),
ADD COLUMN     "lastPlannedAt" TIMESTAMP(3),
ADD COLUMN     "ownerKey" TEXT,
ADD COLUMN     "plannerRunId" TEXT,
ADD COLUMN     "replanCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "supersededById" TEXT,
ADD COLUMN     "wouldExecute" BOOLEAN;

-- AlterTable: placeholder markers are configuration-only and never executable
ALTER TABLE "FulfillmentMarker" ADD COLUMN     "placeholder" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "PlannerRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "status" "PlannerRunStatus" NOT NULL DEFAULT 'RUNNING',
    "trigger" TEXT NOT NULL,
    "automationMode" "AutomationMode" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "countsJson" JSONB,
    "detailsJson" JSONB,
    "error" TEXT,
    "triggeredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlannerRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlannerRun_organizationId_integrationId_startedAt_idx" ON "PlannerRun"("organizationId", "integrationId", "startedAt");

-- Backfill: scope snapshot + owner key for existing live actions (scope from their rule).
UPDATE "AutomationAction" a
SET "eligibilityScope" = r."eligibilityScope",
    "ownerKey" = CASE
      WHEN r."eligibilityScope" = 'CUSTOMER_PROGRAM' AND s."customerId" IS NOT NULL
        THEN 'c:' || s."customerId" || ':' || j."programId" || ':' || a."targetCycle" || ':' || a."fulfillmentMarkerId"
      ELSE 'j:' || a."journeyId" || ':' || a."targetCycle" || ':' || a."fulfillmentMarkerId"
    END
FROM "AutomationRule" r, "SubscriptionJourney" j, "Subscription" s
WHERE a."ruleId" = r."id" AND a."journeyId" = j."id" AND a."subscriptionId" = s."id" AND a."liveKey" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "AutomationAction_ownerKey_key" ON "AutomationAction"("ownerKey");

-- AddForeignKey
ALTER TABLE "AutomationAction" ADD CONSTRAINT "AutomationAction_plannerRunId_fkey" FOREIGN KEY ("plannerRunId") REFERENCES "PlannerRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannerRun" ADD CONSTRAINT "PlannerRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannerRun" ADD CONSTRAINT "PlannerRun_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

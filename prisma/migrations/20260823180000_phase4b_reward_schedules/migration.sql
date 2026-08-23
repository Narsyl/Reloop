-- Phase 4b: reusable reward schedules (RewardItem, RewardSchedule, RewardScheduleMilestone, ProgramMilestoneMarker).
-- Additive only: no lifecycle table (Subscription / SubscriptionOrder / SubscriptionJourney / JourneyCycle) is touched.

-- CreateEnum
CREATE TYPE "RewardScheduleStatus" AS ENUM ('DRAFT', 'READY', 'ARCHIVED');
-- CreateEnum
CREATE TYPE "MilestoneExecutionMode" AS ENUM ('UPCOMING_RENEWAL', 'INITIAL_CHECKOUT');
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.
ALTER TYPE "EntityType" ADD VALUE 'REWARD_SCHEDULE';
ALTER TYPE "EntityType" ADD VALUE 'REWARD_ITEM';
-- AlterTable
ALTER TABLE "AutomationAction" ADD COLUMN     "programId" TEXT,
ADD COLUMN     "rewardScheduleMilestoneId" TEXT;
-- AlterTable
ALTER TABLE "AutomationRule" ADD COLUMN     "migratedToMilestoneId" TEXT;
-- AlterTable
ALTER TABLE "FulfillmentMarker" ADD COLUMN     "operationalNote" TEXT,
ADD COLUMN     "rewardItemId" TEXT;
-- AlterTable
ALTER TABLE "SubscriptionProgram" ADD COLUMN     "rewardScheduleAssignedAt" TIMESTAMP(3),
ADD COLUMN     "rewardScheduleId" TEXT;
-- CreateTable
CREATE TABLE "RewardItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "operationalDescription" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RewardItem_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "RewardSchedule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "RewardScheduleStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RewardSchedule_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "RewardScheduleMilestone" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "cycleNumber" INTEGER NOT NULL,
    "rewardItemId" TEXT NOT NULL,
    "executionMode" "MilestoneExecutionMode" NOT NULL,
    "eligibilityScope" "EligibilityScope" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RewardScheduleMilestone_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "ProgramMilestoneMarker" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "rewardScheduleMilestoneId" TEXT NOT NULL,
    "fulfillmentMarkerId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProgramMilestoneMarker_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "RewardItem_organizationId_name_key" ON "RewardItem"("organizationId", "name");
-- CreateIndex
CREATE UNIQUE INDEX "RewardSchedule_organizationId_name_key" ON "RewardSchedule"("organizationId", "name");
-- CreateIndex
CREATE INDEX "RewardScheduleMilestone_organizationId_idx" ON "RewardScheduleMilestone"("organizationId");
-- CreateIndex
CREATE UNIQUE INDEX "RewardScheduleMilestone_scheduleId_cycleNumber_key" ON "RewardScheduleMilestone"("scheduleId", "cycleNumber");
-- CreateIndex
CREATE INDEX "ProgramMilestoneMarker_organizationId_idx" ON "ProgramMilestoneMarker"("organizationId");
-- CreateIndex
CREATE UNIQUE INDEX "ProgramMilestoneMarker_programId_rewardScheduleMilestoneId_key" ON "ProgramMilestoneMarker"("programId", "rewardScheduleMilestoneId");
-- AddForeignKey
ALTER TABLE "SubscriptionProgram" ADD CONSTRAINT "SubscriptionProgram_rewardScheduleId_fkey" FOREIGN KEY ("rewardScheduleId") REFERENCES "RewardSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "FulfillmentMarker" ADD CONSTRAINT "FulfillmentMarker_rewardItemId_fkey" FOREIGN KEY ("rewardItemId") REFERENCES "RewardItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "AutomationAction" ADD CONSTRAINT "AutomationAction_rewardScheduleMilestoneId_fkey" FOREIGN KEY ("rewardScheduleMilestoneId") REFERENCES "RewardScheduleMilestone"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "AutomationAction" ADD CONSTRAINT "AutomationAction_programId_fkey" FOREIGN KEY ("programId") REFERENCES "SubscriptionProgram"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "RewardItem" ADD CONSTRAINT "RewardItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "RewardSchedule" ADD CONSTRAINT "RewardSchedule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "RewardScheduleMilestone" ADD CONSTRAINT "RewardScheduleMilestone_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "RewardScheduleMilestone" ADD CONSTRAINT "RewardScheduleMilestone_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "RewardSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "RewardScheduleMilestone" ADD CONSTRAINT "RewardScheduleMilestone_rewardItemId_fkey" FOREIGN KEY ("rewardItemId") REFERENCES "RewardItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ProgramMilestoneMarker" ADD CONSTRAINT "ProgramMilestoneMarker_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ProgramMilestoneMarker" ADD CONSTRAINT "ProgramMilestoneMarker_programId_fkey" FOREIGN KEY ("programId") REFERENCES "SubscriptionProgram"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ProgramMilestoneMarker" ADD CONSTRAINT "ProgramMilestoneMarker_rewardScheduleMilestoneId_fkey" FOREIGN KEY ("rewardScheduleMilestoneId") REFERENCES "RewardScheduleMilestone"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ProgramMilestoneMarker" ADD CONSTRAINT "ProgramMilestoneMarker_fulfillmentMarkerId_fkey" FOREIGN KEY ("fulfillmentMarkerId") REFERENCES "FulfillmentMarker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Delivery 1 is never planned by the renewal planner: it is INITIAL_CHECKOUT by definition, and only cycle 1 can be.
ALTER TABLE "RewardScheduleMilestone" ADD CONSTRAINT "RewardScheduleMilestone_cycle_mode_check"
  CHECK ("cycleNumber" >= 1 AND (("cycleNumber" = 1) = ("executionMode" = 'INITIAL_CHECKOUT')));

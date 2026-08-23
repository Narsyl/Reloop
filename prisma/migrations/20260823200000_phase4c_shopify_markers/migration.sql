-- Phase 4c: Shopify marker integration (catalogue + marker identity/verification only). Additive.

-- CreateEnum
CREATE TYPE "RechargeCompatibility" AS ENUM ('UNVERIFIED', 'VERIFIED', 'INCOMPATIBLE');
-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'SHOPIFY';
-- AlterTable
ALTER TABLE "FulfillmentMarker" ADD COLUMN     "lastVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "rechargeCompatibility" "RechargeCompatibility" NOT NULL DEFAULT 'UNVERIFIED',
ADD COLUMN     "shopifyHandle" TEXT,
ADD COLUMN     "shopifyIntegrationId" TEXT,
ADD COLUMN     "shopifyInventoryTracked" BOOLEAN,
ADD COLUMN     "shopifyPrice" TEXT,
ADD COLUMN     "shopifyPublishedOnlineStore" BOOLEAN,
ADD COLUMN     "shopifyStatus" TEXT,
ADD COLUMN     "verificationJson" JSONB;
-- AlterTable
ALTER TABLE "Integration" ADD COLUMN     "pairedIntegrationId" TEXT;
-- AlterTable
ALTER TABLE "SubscriptionProgram" ADD COLUMN     "markerLabel" TEXT,
ADD COLUMN     "skuPrefix" TEXT;
-- CreateIndex
CREATE UNIQUE INDEX "FulfillmentMarker_shopifyIntegrationId_externalVariantId_key" ON "FulfillmentMarker"("shopifyIntegrationId", "externalVariantId");
-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_pairedIntegrationId_fkey" FOREIGN KEY ("pairedIntegrationId") REFERENCES "Integration"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "FulfillmentMarker" ADD CONSTRAINT "FulfillmentMarker_shopifyIntegrationId_fkey" FOREIGN KEY ("shopifyIntegrationId") REFERENCES "Integration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

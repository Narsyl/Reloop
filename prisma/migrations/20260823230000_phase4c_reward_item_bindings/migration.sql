-- Revised Phase 4c (23 Aug 2026): physical RewardItems own their fulfilment variant; Shopify is read-only.
--
--  * RewardItemExternalBinding: reward item × commerce (SHOPIFY) integration → existing product/variant
--    (canonical externalVariantId), verified snapshot, rechargeCompatibility.
--  * AutomationAction.rewardItemId (new actions reference the reward; fulfillmentMarkerId becomes legacy/nullable).
--  * Integration.encryptedAccessToken / accessTokenExpiresAt: ephemeral client-credentials token cache.
--  * The 26-marker model is retired: the Shopify verification columns added to FulfillmentMarker earlier today
--    (never populated) and SubscriptionProgram.markerLabel/skuPrefix are dropped. FulfillmentMarker and
--    ProgramMilestoneMarker stay as LEGACY history tables (no longer written or executed against).
--  * Tenant-guard triggers updated: markers (Recharge integration same org), reward bindings (reward item and
--    integration same org, provider matches), pairing (unchanged).
-- Lifecycle tables (Subscription/SubscriptionOrder/SubscriptionJourney/JourneyCycle/mappings) are untouched.

-- ── AutomationAction: reward item reference; marker legacy ──────────────────────────────
ALTER TABLE "AutomationAction" ADD COLUMN "rewardItemId" TEXT,
  ALTER COLUMN "fulfillmentMarkerId" DROP NOT NULL;
ALTER TABLE "AutomationAction" ADD CONSTRAINT "AutomationAction_rewardItemId_fkey" FOREIGN KEY ("rewardItemId") REFERENCES "RewardItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Backfill: legacy actions whose marker already names a reward item
UPDATE "AutomationAction" a SET "rewardItemId" = m."rewardItemId"
  FROM "FulfillmentMarker" m
  WHERE a."fulfillmentMarkerId" = m.id AND a."rewardItemId" IS NULL AND m."rewardItemId" IS NOT NULL;

-- ── Integration: ephemeral access-token cache ───────────────────────────────────────────
ALTER TABLE "Integration" ADD COLUMN "accessTokenExpiresAt" TIMESTAMP(3),
  ADD COLUMN "encryptedAccessToken" TEXT;

-- ── RewardItemExternalBinding ───────────────────────────────────────────────────────────
CREATE TABLE "RewardItemExternalBinding" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "rewardItemId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "externalProductId" TEXT NOT NULL,
    "externalVariantId" TEXT NOT NULL,
    "externalTitle" TEXT NOT NULL,
    "externalVariantTitle" TEXT,
    "externalSku" TEXT,
    "externalPrice" TEXT,
    "externalStatus" TEXT,
    "externalHandle" TEXT,
    "requiresShipping" BOOLEAN,
    "inventoryTracked" BOOLEAN,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastVerifiedAt" TIMESTAMP(3),
    "verificationJson" JSONB,
    "rechargeCompatibility" "RechargeCompatibility" NOT NULL DEFAULT 'UNVERIFIED',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RewardItemExternalBinding_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RewardItemExternalBinding_organizationId_idx" ON "RewardItemExternalBinding"("organizationId");
CREATE UNIQUE INDEX "RewardItemExternalBinding_rewardItemId_integrationId_key" ON "RewardItemExternalBinding"("rewardItemId", "integrationId");
CREATE UNIQUE INDEX "RewardItemExternalBinding_integrationId_externalVariantId_key" ON "RewardItemExternalBinding"("integrationId", "externalVariantId");
ALTER TABLE "RewardItemExternalBinding" ADD CONSTRAINT "RewardItemExternalBinding_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RewardItemExternalBinding" ADD CONSTRAINT "RewardItemExternalBinding_rewardItemId_fkey" FOREIGN KEY ("rewardItemId") REFERENCES "RewardItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RewardItemExternalBinding" ADD CONSTRAINT "RewardItemExternalBinding_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Retire the 26-marker model (columns never populated for any tenant) ─────────────────
DROP TRIGGER IF EXISTS fulfillment_marker_tenant_guard ON "FulfillmentMarker";
ALTER TABLE "FulfillmentMarker" DROP CONSTRAINT "FulfillmentMarker_shopifyIntegrationId_fkey";
DROP INDEX "FulfillmentMarker_shopifyIntegrationId_externalVariantId_key";
ALTER TABLE "FulfillmentMarker"
  DROP COLUMN "lastVerifiedAt",
  DROP COLUMN "rechargeCompatibility",
  DROP COLUMN "shopifyHandle",
  DROP COLUMN "shopifyIntegrationId",
  DROP COLUMN "shopifyInventoryTracked",
  DROP COLUMN "shopifyPrice",
  DROP COLUMN "shopifyPublishedOnlineStore",
  DROP COLUMN "shopifyStatus",
  DROP COLUMN "verificationJson";
ALTER TABLE "SubscriptionProgram" DROP COLUMN "markerLabel", DROP COLUMN "skuPrefix";

-- ── Tenant guards ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fulfillment_marker_tenant_guard() RETURNS trigger AS $$
DECLARE
  v_org TEXT;
BEGIN
  SELECT "organizationId" INTO v_org FROM "Integration" WHERE id = NEW."integrationId";
  IF v_org IS NULL OR v_org <> NEW."organizationId" THEN
    RAISE EXCEPTION 'FulfillmentMarker % cannot reference integration % of another organisation', NEW.id, NEW."integrationId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER fulfillment_marker_tenant_guard
  BEFORE INSERT OR UPDATE OF "integrationId", "organizationId" ON "FulfillmentMarker"
  FOR EACH ROW EXECUTE FUNCTION fulfillment_marker_tenant_guard();

CREATE OR REPLACE FUNCTION reward_binding_tenant_guard() RETURNS trigger AS $$
DECLARE
  v_org TEXT;
  v_provider "IntegrationProvider";
BEGIN
  SELECT "organizationId" INTO v_org FROM "RewardItem" WHERE id = NEW."rewardItemId";
  IF v_org IS NULL OR v_org <> NEW."organizationId" THEN
    RAISE EXCEPTION 'RewardItemExternalBinding % cannot reference reward item % of another organisation', NEW.id, NEW."rewardItemId"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "organizationId", provider INTO v_org, v_provider FROM "Integration" WHERE id = NEW."integrationId";
  IF v_org IS NULL OR v_org <> NEW."organizationId" THEN
    RAISE EXCEPTION 'RewardItemExternalBinding % cannot reference integration % of another organisation', NEW.id, NEW."integrationId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_provider <> NEW.provider THEN
    RAISE EXCEPTION 'RewardItemExternalBinding % provider % does not match integration provider %', NEW.id, NEW.provider, v_provider
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS reward_binding_tenant_guard ON "RewardItemExternalBinding";
CREATE TRIGGER reward_binding_tenant_guard
  BEFORE INSERT OR UPDATE OF "rewardItemId", "integrationId", "organizationId", "provider" ON "RewardItemExternalBinding"
  FOR EACH ROW EXECUTE FUNCTION reward_binding_tenant_guard();

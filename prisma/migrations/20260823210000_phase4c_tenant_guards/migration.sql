-- Phase 4c: database-level tenant guards for the Shopify marker integration.
--
-- Prisma cannot express "this FK must point at a row of the SAME organisation", so these triggers
-- enforce it at the database:
--   * FulfillmentMarker.integrationId        -> Integration of the same organisation (the Recharge store)
--   * FulfillmentMarker.shopifyIntegrationId -> SHOPIFY Integration of the same organisation
--   * Integration.pairedIntegrationId        -> RECHARGE Integration of the same organisation
-- Triggers/functions are invisible to Prisma's diff, so they never create migration drift.

-- Fail closed if existing rows already violate the invariants (none are expected).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "FulfillmentMarker" m JOIN "Integration" i ON i.id = m."integrationId" WHERE i."organizationId" <> m."organizationId") THEN
    RAISE EXCEPTION 'phase4c_tenant_guards: FulfillmentMarker.integrationId crosses organisations';
  END IF;
  IF EXISTS (SELECT 1 FROM "FulfillmentMarker" m JOIN "Integration" i ON i.id = m."shopifyIntegrationId" WHERE i."organizationId" <> m."organizationId" OR i.provider <> 'SHOPIFY') THEN
    RAISE EXCEPTION 'phase4c_tenant_guards: FulfillmentMarker.shopifyIntegrationId crosses organisations or is not SHOPIFY';
  END IF;
  IF EXISTS (SELECT 1 FROM "Integration" s JOIN "Integration" r ON r.id = s."pairedIntegrationId" WHERE r."organizationId" <> s."organizationId" OR r.provider <> 'RECHARGE') THEN
    RAISE EXCEPTION 'phase4c_tenant_guards: Integration.pairedIntegrationId crosses organisations or is not RECHARGE';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION fulfillment_marker_tenant_guard() RETURNS trigger AS $$
DECLARE
  v_org TEXT;
  v_provider "IntegrationProvider";
BEGIN
  SELECT "organizationId" INTO v_org FROM "Integration" WHERE id = NEW."integrationId";
  IF v_org IS NULL OR v_org <> NEW."organizationId" THEN
    RAISE EXCEPTION 'FulfillmentMarker % cannot reference integration % of another organisation', NEW.id, NEW."integrationId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."shopifyIntegrationId" IS NOT NULL THEN
    SELECT "organizationId", provider INTO v_org, v_provider FROM "Integration" WHERE id = NEW."shopifyIntegrationId";
    IF v_org IS NULL OR v_org <> NEW."organizationId" THEN
      RAISE EXCEPTION 'FulfillmentMarker % cannot reference Shopify integration % of another organisation', NEW.id, NEW."shopifyIntegrationId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_provider <> 'SHOPIFY' THEN
      RAISE EXCEPTION 'FulfillmentMarker % shopifyIntegrationId % is not a SHOPIFY integration', NEW.id, NEW."shopifyIntegrationId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fulfillment_marker_tenant_guard ON "FulfillmentMarker";
CREATE TRIGGER fulfillment_marker_tenant_guard
  BEFORE INSERT OR UPDATE OF "integrationId", "shopifyIntegrationId", "organizationId" ON "FulfillmentMarker"
  FOR EACH ROW EXECUTE FUNCTION fulfillment_marker_tenant_guard();

CREATE OR REPLACE FUNCTION integration_pairing_tenant_guard() RETURNS trigger AS $$
DECLARE
  v_org TEXT;
  v_provider "IntegrationProvider";
BEGIN
  IF NEW."pairedIntegrationId" IS NOT NULL THEN
    IF NEW."pairedIntegrationId" = NEW.id THEN
      RAISE EXCEPTION 'Integration % cannot be paired with itself', NEW.id USING ERRCODE = 'check_violation';
    END IF;
    SELECT "organizationId", provider INTO v_org, v_provider FROM "Integration" WHERE id = NEW."pairedIntegrationId";
    IF v_org IS NULL OR v_org <> NEW."organizationId" THEN
      RAISE EXCEPTION 'Integration % cannot be paired with integration % of another organisation', NEW.id, NEW."pairedIntegrationId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_provider <> 'RECHARGE' THEN
      RAISE EXCEPTION 'Integration % can only be paired with a RECHARGE integration (got %)', NEW.id, v_provider
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS integration_pairing_tenant_guard ON "Integration";
CREATE TRIGGER integration_pairing_tenant_guard
  BEFORE INSERT OR UPDATE OF "pairedIntegrationId", "organizationId" ON "Integration"
  FOR EACH ROW EXECUTE FUNCTION integration_pairing_tenant_guard();

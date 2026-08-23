-- Phase 6: single-armed controlled-test authorization — the only road to a Recharge one-time write.
-- armedKey (= integrationId while ARMED, else NULL) is UNIQUE: at most one armed action per integration,
-- enforced by the database. Additive only; lifecycle tables untouched.

CREATE TYPE "ControlledTestStatus" AS ENUM ('ARMED', 'CONSUMED', 'CLEARED', 'EXPIRED');

-- CreateTable
CREATE TABLE "ControlledTestAuthorization" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "status" "ControlledTestStatus" NOT NULL DEFAULT 'ARMED',
    "armedKey" TEXT,
    "armedById" TEXT,
    "armedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "clearedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "resultJson" JSONB,
    "note" TEXT,

    CONSTRAINT "ControlledTestAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ControlledTestAuthorization_actionId_key" ON "ControlledTestAuthorization"("actionId");

-- CreateIndex
CREATE UNIQUE INDEX "ControlledTestAuthorization_armedKey_key" ON "ControlledTestAuthorization"("armedKey");

-- CreateIndex
CREATE INDEX "ControlledTestAuthorization_organizationId_status_idx" ON "ControlledTestAuthorization"("organizationId", "status");

-- AddForeignKey
ALTER TABLE "ControlledTestAuthorization" ADD CONSTRAINT "ControlledTestAuthorization_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ControlledTestAuthorization" ADD CONSTRAINT "ControlledTestAuthorization_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ControlledTestAuthorization" ADD CONSTRAINT "ControlledTestAuthorization_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "AutomationAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- Tenant guard: the authorization must reference an integration and action of its own organisation.
CREATE OR REPLACE FUNCTION controlled_test_tenant_guard() RETURNS trigger AS $$
DECLARE
  v_org TEXT;
BEGIN
  SELECT "organizationId" INTO v_org FROM "Integration" WHERE id = NEW."integrationId";
  IF v_org IS NULL OR v_org <> NEW."organizationId" THEN
    RAISE EXCEPTION 'ControlledTestAuthorization % cannot reference integration % of another organisation', NEW.id, NEW."integrationId" USING ERRCODE = 'check_violation';
  END IF;
  SELECT "organizationId" INTO v_org FROM "AutomationAction" WHERE id = NEW."actionId";
  IF v_org IS NULL OR v_org <> NEW."organizationId" THEN
    RAISE EXCEPTION 'ControlledTestAuthorization % cannot reference action % of another organisation', NEW.id, NEW."actionId" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS controlled_test_tenant_guard ON "ControlledTestAuthorization";
CREATE TRIGGER controlled_test_tenant_guard
  BEFORE INSERT OR UPDATE OF "integrationId", "actionId", "organizationId" ON "ControlledTestAuthorization"
  FOR EACH ROW EXECUTE FUNCTION controlled_test_tenant_guard();

-- Journey versions and repeating journeys.
--
-- ProgramScheduleVersion: journeys STARTED on or after effectiveFrom resolve that version's
-- schedule (latest applicable wins); journeys older than every version keep the programme's
-- baseline rewardScheduleId. Purely additive: nothing changes until a version row exists.
--
-- RewardSchedule.repeats: the gift sequence loops after its highest delivery. Laps beyond the
-- first treat an INITIAL_CHECKOUT position as an ordinary renewal gift (only the true first
-- box predates the subscription being visible).

ALTER TABLE "RewardSchedule" ADD COLUMN IF NOT EXISTS "repeats" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ProgramScheduleVersion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProgramScheduleVersion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProgramScheduleVersion_programId_effectiveFrom_idx" ON "ProgramScheduleVersion"("programId", "effectiveFrom");

ALTER TABLE "ProgramScheduleVersion" ADD CONSTRAINT "ProgramScheduleVersion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProgramScheduleVersion" ADD CONSTRAINT "ProgramScheduleVersion_programId_fkey" FOREIGN KEY ("programId") REFERENCES "SubscriptionProgram"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProgramScheduleVersion" ADD CONSTRAINT "ProgramScheduleVersion_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "RewardSchedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Tenant guard: the version's programme and schedule must belong to the version's organisation.
CREATE OR REPLACE FUNCTION program_schedule_version_tenant_guard() RETURNS trigger AS $$
DECLARE
  v_org TEXT;
BEGIN
  SELECT "organizationId" INTO v_org FROM "SubscriptionProgram" WHERE id = NEW."programId";
  IF v_org IS NULL OR v_org <> NEW."organizationId" THEN
    RAISE EXCEPTION 'ProgramScheduleVersion % cannot reference programme % of another organisation', NEW.id, NEW."programId"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "organizationId" INTO v_org FROM "RewardSchedule" WHERE id = NEW."scheduleId";
  IF v_org IS NULL OR v_org <> NEW."organizationId" THEN
    RAISE EXCEPTION 'ProgramScheduleVersion % cannot reference schedule % of another organisation', NEW.id, NEW."scheduleId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS program_schedule_version_tenant_guard ON "ProgramScheduleVersion";
CREATE TRIGGER program_schedule_version_tenant_guard
  BEFORE INSERT OR UPDATE ON "ProgramScheduleVersion"
  FOR EACH ROW EXECUTE FUNCTION program_schedule_version_tenant_guard();

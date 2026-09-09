-- LIVE execution: every executed action records the authority it ran under.
-- CONTROLLED_TEST = a consumed single-use ControlledTestAuthorization (Phase 6).
-- LIVE_AUTOMATION = the live mode executor (fresh preflight, atomic claim, read-back).
ALTER TABLE "AutomationAction" ADD COLUMN IF NOT EXISTS "executedVia" TEXT;

-- The four Phase 6 writes all ran under consumed ControlledTestAuthorizations.
UPDATE "AutomationAction" SET "executedVia" = 'CONTROLLED_TEST' WHERE "executedAt" IS NOT NULL AND "executedVia" IS NULL;

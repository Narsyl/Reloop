# Database migrations — safe workflow (fail-closed)

**Incident, 23 Aug 2026:** a `prisma migrate diff … --shadow-database-url "$(grep … .env.local)"` was run with a shell
fallback that resolved to the real `DATABASE_URL`. Prisma's shadow procedure *drops and recreates the schema it is
pointed at*, so the dev Neon database was emptied (recovered by Neon point-in-time restore). The rules below make that
class of mistake impossible to repeat from this repository.

## Rules

1. **Never** pass `--shadow-database-url` by hand, and never let a shell expression choose it.
2. A shadow database must be a **dedicated** database: on Neon, a separate branch (preferred) or a separate database
   on the branch. Put its connection string in `.env.local` as `SHADOW_DATABASE_URL`.
3. `prisma migrate reset`, `prisma db push --force-reset` and `prisma db execute` are not used in this repo. If you
   truly need one, run it by hand against a database you intend to destroy, after checking which URL it targets.
4. Every shadow/destructive-capable operation goes through `scripts/db/safe-prisma.mjs`, which **fails closed**:
   missing `SHADOW_DATABASE_URL` → refused; identical to `DATABASE_URL` → refused; same host **and** same database
   name → refused; any caller-supplied `--shadow-database-url` / `reset` / `--force-reset` → refused.

## Commands

| Command | What it does | Touches |
|---|---|---|
| `npm run db:status` | `prisma migrate status` | reads `_prisma_migrations` |
| `npm run db:deploy` | `prisma migrate deploy` — applies pending migration files | the real DB, additive only |
| `npm run db:diff:live` | `prisma migrate diff --from-schema-datasource … --to-schema-datamodel … --script` — **read-only introspection** of the live DB vs `schema.prisma`; the everyday way to draft a migration | reads the real DB |
| `npm run db:diff` | `prisma migrate diff --from-migrations … --to-schema-datamodel …` using the **validated** `SHADOW_DATABASE_URL` | the shadow DB only |
| `npm run db:migrate:dev` | `prisma migrate dev` with the validated shadow URL exported | real DB (applies) + shadow DB |

Hand-authoring a migration (the normal flow here): edit `prisma/schema.prisma` → `npm run db:diff:live` → paste/adjust
the SQL into `prisma/migrations/<timestamp>_<name>/migration.sql` (add backfills, CHECKs, triggers) → `npm run db:deploy`
→ `npx prisma generate` → `npm run db:status` must say "Database schema is up to date!".

## Claude Code guard

`.claude/settings.json` (committed) denies `Bash` commands containing `--shadow-database-url`, `prisma migrate reset`,
`--force-reset`, and runs `scripts/db/claude-guard.cjs` as a `PreToolUse` hook that refuses the same patterns by regex
(this also covers infix/compound forms and heredocs). Verified by attempting a harmless `echo "--shadow-database-url"` —
it must be refused. The same rules are mirrored in the developer's working-directory `.claude/settings.json`.


## Hand-authored constraints Prisma cannot express

- `20260823180000_phase4b_reward_schedules`: CHECK `cycleNumber = 1 ⇔ executionMode = INITIAL_CHECKOUT` on `RewardScheduleMilestone`.
- `20260823210000_phase4c_tenant_guards`: triggers `fulfillment_marker_tenant_guard` (marker.integrationId / shopifyIntegrationId must belong to the same organisation; shopifyIntegrationId must be a SHOPIFY integration) and `integration_pairing_tenant_guard` (pairedIntegrationId must be a same-organisation RECHARGE integration). Triggers/functions are invisible to `prisma migrate diff`, so they never show as drift; keep them in mind when writing fixtures.

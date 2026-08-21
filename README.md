# Subscription Ops

Multi-tenant subscription operations platform. Sits between a subscription billing platform (Recharge first) and fulfilment, and performs operational actions — initially inserting £0 *fulfilment markers* into an upcoming shipment — when a subscription reaches a configured successful-delivery cycle inside a **subscription program**.

Architecture, domain model and phased plan: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind v4 + shadcn (Base UI) · PostgreSQL on Neon · Prisma 6 · Better Auth · Inngest · Zod · Vitest

## Local setup

```bash
npm install
cp .env.example .env.local          # fill in DATABASE_URL, DATABASE_URL_UNPOOLED, BETTER_AUTH_SECRET, CREDENTIAL_ENCRYPTION_KEYS
npm run db:migrate                   # applies prisma/migrations to the database in .env.local
npm run db:seed                      # demo data (see below)
npm run dev                          # http://localhost:3000
```

Optional, for background functions locally:

```bash
npm run inngest:dev                  # Inngest dev server pointing at /api/inngest (needs INNGEST_DEV=1 in .env.local)
```

### Demo accounts (after `npm run db:seed`)

| Email | Password | Access |
|---|---|---|
| `demo@subscription-ops.local` | `demo-password-123` | OWNER of "Ancient Extracts Demo", ADMIN of "Northwind Botanicals" |
| `viewer@subscription-ops.local` | `viewer-password-123` | VIEWER of "Ancient Extracts Demo" |

The seed is idempotent — it removes and recreates the demo organisations and users.

## Scripts

| Script | What |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (includes the tenant-isolation import guard) |
| `npm test` | Vitest — unit (crypto) + integration (cross-tenant isolation against the DB in `.env.local`) |
| `npm run db:migrate` / `db:push` / `db:deploy` / `db:studio` | Prisma, loading `.env.local` |
| `npm run db:seed` | Demo data |

## Connecting Recharge (Phase 2)

Settings → Integrations → **Connect Recharge**. Paste an Admin API token with least privilege — Customers, Products, Orders, Store information (*view*) and Subscriptions (*view + manage*) — plus the API client secret. **Test connection** probes the endpoints empirically (premium Events/Credits/Storefront are never called and never required); **Save** encrypts the credentials per integration and queues a read-only initial import. Run `npm run inngest:dev` alongside `npm run dev` so the import executes locally. Progress and history are on the integration's detail page; afterwards create subscription programs on the Products page and assign imported products to them — journeys recalculate automatically. Nothing is ever written to Recharge in this phase.

## Layout

```text
app/(auth)        login / signup
app/(onboarding)  create first organisation
app/(app)         authenticated, organisation-scoped shell and pages
app/api           auth, inngest
components/       ui primitives, layout, data, status, timeline, domain composites
lib/auth          Better Auth, session, tenancy (OrgContext, requireOrg, requireRole)
lib/db            prisma singleton, dbFor(ctx) org-scoped client
lib/crypto        credential encryption (AES-256-GCM, key rotation)
lib/integrations  provider-agnostic DTOs + recharge/ (client, schemas, mapper, resources, capabilities, webhooks)
lib/domain        queries + server actions (always take an OrgContext); sync/, journeys/, programs/, integrations/
lib/jobs          Inngest client, events, functions (integration-sync, journeys-recalculate)
prisma/           schema, migrations, seed
tests/            vitest (unit + DB-backed integration)
```

## Tenant isolation rules

1. Every tenant-owned table has `organizationId`.
2. Read/write tenant data only through `dbFor(ctx)` (`lib/db/tenant.ts`), which injects `organizationId` into every query. ESLint blocks importing the raw client from `app/`, `components/`, `lib/domain/`, `lib/integrations/`.
3. `OrgContext` is built only in `lib/auth/tenancy.ts` from the session + a verified membership row.
4. `tests/integration/tenant-isolation.test.ts` proves cross-tenant reads/writes fail for every tenant model.

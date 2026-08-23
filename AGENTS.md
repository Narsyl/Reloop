<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Database migrations — read `docs/DB-MIGRATIONS.md` first

Prisma shadow/destructive operations are fail-closed in this repo. Use `npm run db:diff:live` (read-only draft),
`npm run db:diff` (validated dedicated shadow DB only), `npm run db:deploy`, `npm run db:status`. Never supply a shadow
database URL yourself and never reset/force-reset a database from here — on 23 Aug 2026 a shell fallback pointed
Prisma's shadow at the real database and emptied it.

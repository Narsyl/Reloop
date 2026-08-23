#!/usr/bin/env node
/**
 * safe-prisma — the ONLY sanctioned entry point for Prisma operations that use a
 * shadow database or can destroy data.
 *
 * Why this exists: on 23 Aug 2026 a `prisma migrate diff --shadow-database-url <DATABASE_URL>`
 * (a shell fallback supplied the real database as the shadow) reset the dev database.
 * Prisma's shadow procedure DROPS the schema it is pointed at. This script fails closed:
 *
 *   - SHADOW_DATABASE_URL must be set, parseable, and must not be the same database as
 *     DATABASE_URL (same host AND same database name → refused; identical strings → refused).
 *   - `--shadow-database-url` can never be supplied by a caller; only this script adds it,
 *     and only from the validated SHADOW_DATABASE_URL.
 *   - `migrate reset`, `db push --force-reset`, `db execute` are refused outright
 *     (run them by hand, consciously, against a database you intend to destroy).
 *
 * Usage (via package.json):
 *   npm run db:status        prisma migrate status
 *   npm run db:deploy        prisma migrate deploy                  (non-destructive)
 *   npm run db:diff          migrations → schema diff using the validated shadow DB
 *   npm run db:diff:live     live DB (introspection, read-only) → schema diff; no shadow DB
 *   npm run db:migrate:dev   prisma migrate dev (Prisma creates/drops its OWN temporary shadow
 *                            database; the validated SHADOW_DATABASE_URL is passed explicitly)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");

function loadEnvFile(file) {
  const p = path.join(root, file);
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvFile(".env.local");
loadEnvFile(".env");

function fail(msg) {
  console.error(`\n✖ safe-prisma refused: ${msg}\n`);
  process.exit(2);
}

function parseDb(url, label) {
  let u;
  try {
    u = new URL(url);
  } catch {
    fail(`${label} is not a valid URL.`);
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) fail(`${label} must be a postgres:// URL.`);
  const database = u.pathname.replace(/^\//, "").split("?")[0];
  if (!u.hostname || !database) fail(`${label} must include a host and a database name.`);
  return { host: u.hostname.toLowerCase(), database, raw: url };
}

function validatedShadowUrl() {
  const main = process.env.DATABASE_URL;
  const shadow = process.env.SHADOW_DATABASE_URL;
  if (!main) fail("DATABASE_URL is not set.");
  if (!shadow || !shadow.trim()) {
    fail("SHADOW_DATABASE_URL is not set. A DEDICATED shadow database is required for shadow operations. On Neon: create a separate branch (or a separate database) and put its connection string in .env.local as SHADOW_DATABASE_URL. Never reuse DATABASE_URL — Prisma drops the shadow schema.");
  }
  if (shadow.trim() === main.trim()) fail("SHADOW_DATABASE_URL is identical to DATABASE_URL. Refusing — Prisma would reset your real database.");
  const m = parseDb(main, "DATABASE_URL");
  const s = parseDb(shadow, "SHADOW_DATABASE_URL");
  if (m.host === s.host && m.database === s.database) fail(`SHADOW_DATABASE_URL points at the same database as DATABASE_URL (${m.host}/${m.database}). Refusing.`);
  if (m.host === s.host) console.error(`⚠ shadow database shares the host ${s.host} (different database "${s.database}"). Prefer a separate Neon branch.`);
  return shadow.trim();
}

const FORBIDDEN = [/--shadow-database-url/i, /\bmigrate\s+reset\b/i, /--force-reset/i, /\bdb\s+execute\b/i];
const argv = process.argv.slice(2);
const joined = argv.join(" ");
for (const re of FORBIDDEN) if (re.test(joined)) fail(`argument matches a forbidden pattern (${re}). This script adds the shadow URL itself and never runs reset/force-reset.`);

const [cmd, ...rest] = argv;
const prismaBin = process.platform === "win32" ? "npx.cmd" : "npx";
function run(args) {
  console.error(`→ prisma ${args.map((a) => (a.startsWith("postgres") ? "<url>" : a)).join(" ")}`);
  const r = spawnSync(prismaBin, ["prisma", ...args], { stdio: "inherit", cwd: root, shell: process.platform === "win32" });
  process.exit(r.status ?? 1);
}

switch (cmd) {
  case "status":
    run(["migrate", "status", ...rest]);
    break;
  case "deploy":
    run(["migrate", "deploy", ...rest]);
    break;
  case "diff:live":
    // Read-only: introspects the live database; never touches a shadow DB.
    run(["migrate", "diff", "--from-schema-datasource", "prisma/schema.prisma", "--to-schema-datamodel", "prisma/schema.prisma", "--script", ...rest]);
    break;
  case "diff": {
    const shadow = validatedShadowUrl();
    run(["migrate", "diff", "--from-migrations", "prisma/migrations", "--to-schema-datamodel", "prisma/schema.prisma", "--shadow-database-url", shadow, "--script", ...rest]);
    break;
  }
  case "migrate:dev": {
    const shadow = validatedShadowUrl();
    // migrate dev needs a shadow DB for drift detection; pass the validated one explicitly
    // (env SHADOW_DATABASE_URL is also read by the schema's shadowDatabaseUrl if declared).
    process.env.SHADOW_DATABASE_URL = shadow;
    run(["migrate", "dev", ...rest]);
    break;
  }
  default:
    console.error("usage: safe-prisma <status|deploy|diff|diff:live|migrate:dev> [extra prisma args]");
    process.exit(2);
}

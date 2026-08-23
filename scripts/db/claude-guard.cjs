// Claude Code PreToolUse hook (Bash): refuse shadow/reset Prisma operations in this repo.
// Reads the tool input JSON on stdin; prints a deny decision when the command matches.
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let c = "";
  try { c = JSON.parse(s).tool_input?.command ?? ""; } catch {}
  const bad = /--shadow-database-url|shadowDatabaseUrl|prisma\s+(?:\S+\s+)*migrate\s+reset|--force-reset|prisma\s+(?:\S+\s+)*db\s+execute/i;
  if (bad.test(c)) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Repo guard: shadow-database / reset / force-reset Prisma operations are forbidden here. Use `npm run db:diff` (validated dedicated SHADOW_DATABASE_URL), `npm run db:diff:live` (read-only), `npm run db:deploy`. See docs/DB-MIGRATIONS.md (incident 23 Aug 2026)." } }));
  }
});

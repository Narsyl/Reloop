/**
 * Read-only integrity report for a tenant database — written for the post-PITR check on
 * 23 Aug 2026 but generic: compares the live database against expected counts/keys and
 * verifies that every natural key is unique and that integration credentials decrypt.
 *
 *   npx dotenv -e .env.local -- tsx scripts/db/integrity-check.ts [org-slug] [--expect key=value,...]
 *
 * Performs NO writes (Prisma reads + SELECTs only) and never prints secrets.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { decryptCredentials, hasDecryptionKeyFor } from "../../lib/crypto/credentials";

const prisma = new PrismaClient();
const slug = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "ancient-extracts";
const expectArg = process.argv.find((a) => a.startsWith("--expect="));
const expected: Record<string, number> = {};
if (expectArg) for (const kv of expectArg.slice("--expect=".length).split(",")) { const [k, v] = kv.split("="); if (k && v) expected[k] = Number(v); }

type Line = { check: string; ok: boolean | null; detail: string };
const lines: Line[] = [];
const add = (check: string, ok: boolean | null, detail: string) => lines.push({ check, ok, detail });
const cmp = (key: string, actual: number, min?: number) => {
  const exp = expected[key] ?? min;
  const ok = exp === undefined ? null : actual >= exp;
  add(key, ok, exp === undefined ? String(actual) : `${actual} (expected ≥ ${exp})`);
};

async function dupes(label: string, sql: string) {
  const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(sql);
  const n = Number(rows[0]?.n ?? 0);
  add(`no duplicate ${label}`, n === 0, n === 0 ? "0 duplicates" : `${n} duplicate groups`);
}

async function main() {
  const org = await prisma.organization.findUnique({ where: { slug } });
  add("organisation present", !!org, org ? `${org.name} (${org.id}) tz=${org.timezone} lead=${org.markerLeadHours}h` : `slug "${slug}" not found`);
  if (!org) return;
  const O = { organizationId: org.id };

  const migrations = await prisma.$queryRawUnsafe<{ migration_name: string; finished_at: Date | null }[]>(`select migration_name, finished_at from "_prisma_migrations" order by started_at`).catch(() => null);
  add("_prisma_migrations present", !!migrations, migrations ? `${migrations.length} applied: ${migrations.map((m) => m.migration_name.replace(/^\d+_/, "")).join(", ")}` : "table missing");
  add("phase4 migration applied", !!migrations?.some((m) => m.migration_name.includes("phase4") && m.finished_at), migrations?.some((m) => m.migration_name.includes("phase4")) ? "yes" : "no");

  const integrations = await prisma.integration.findMany({ where: O });
  add("integration present", integrations.length > 0, integrations.map((i) => `${i.displayName} status=${i.status} mode=${i.automationMode} lastSync=${i.lastSuccessfulSyncAt?.toISOString() ?? "—"}`).join("; ") || "none");
  for (const i of integrations) {
    const keyOk = hasDecryptionKeyFor(i.encryptedCredentials);
    let decrypts = false;
    let shape = "";
    if (keyOk) {
      try {
        const c = decryptCredentials<{ apiToken?: string; clientSecret?: string | null }>(i.encryptedCredentials, i.id);
        decrypts = typeof c.apiToken === "string" && c.apiToken.length > 10;
        shape = `apiToken ${c.apiToken ? `${c.apiToken.length} chars` : "missing"}, clientSecret ${c.clientSecret ? "present" : "none"}`;
      } catch (e) {
        shape = String(e).slice(0, 80);
      }
    }
    add(`credentials decryptable (${i.displayName})`, keyOk && decrypts, keyOk ? shape : "no key on this host for this blob");
  }

  cmp("customers", await prisma.customer.count({ where: O }));
  const subs = await prisma.subscription.count({ where: O });
  cmp("subscriptions", subs);
  cmp("subscriptions.active", await prisma.subscription.count({ where: { ...O, status: "ACTIVE" } }));
  cmp("subscriptions.mapped", await prisma.subscription.count({ where: { ...O, mappingStatus: "MAPPED" } }));
  cmp("subscriptionOrders", await prisma.subscriptionOrder.count({ where: O }));
  cmp("journeys", await prisma.subscriptionJourney.count({ where: O }));
  cmp("journeyCycles", await prisma.journeyCycle.count({ where: O }));
  cmp("products", await prisma.product.count({ where: O }));
  cmp("variants", await prisma.productVariant.count({ where: O }));

  const programs = await prisma.subscriptionProgram.findMany({ where: O, include: { products: { include: { product: { select: { externalProductId: true } } } } }, orderBy: { name: "asc" } });
  add("programmes + mappings", programs.length > 0, programs.map((p) => `${p.name} [${p.products.map((m) => m.product.externalProductId + (m.variantScope === "*" ? "" : `/${m.variantScope}`)).join(" + ")}]`).join(" · ") || "none");
  cmp("programmes", programs.length);
  cmp("programMappings", programs.reduce((n, p) => n + p.products.length, 0));

  const rules = await prisma.automationRule.findMany({ where: O, include: { fulfillmentMarker: true, program: true } });
  add("rules", rules.length > 0, rules.map((r) => `"${r.name}" ${r.status} scope=${r.eligibilityScope ?? "—"} cycle=${r.cycleNumber} → ${r.fulfillmentMarker.name}`).join(" · ") || "none");
  const markers = await prisma.fulfillmentMarker.findMany({ where: O });
  add("markers", markers.length > 0, markers.map((m) => `"${m.name}" variant=${m.externalVariantId} title="${m.title}" active=${m.active} placeholder=${m.placeholder}`).join(" · ") || "none");

  const syncs = await prisma.integrationSync.findMany({ where: O, orderBy: { createdAt: "asc" } });
  cmp("integrationSyncs", syncs.length);
  add("sync history", syncs.length > 0, syncs.map((s) => `${s.createdAt.toISOString().slice(0, 16)} ${s.kind} ${s.status}`).join(" | ") || "none");
  cmp("activityLogs", await prisma.activityLog.count({ where: O }));
  cmp("exceptions.open", await prisma.exception.count({ where: { ...O, status: "OPEN" } }));
  const actions = await prisma.automationAction.count({ where: O });
  add("AutomationAction rows", actions === (expected.actions ?? 0), `${actions}`);
  cmp("plannerRuns", await prisma.plannerRun.count({ where: O }).catch(() => -1));

  // natural-key uniqueness (DB-enforced, but verify the restored data honours it)
  await dupes("subscriptions (integration, externalSubscriptionId)", `select count(*)::bigint as n from (select "integrationId","externalSubscriptionId" from "Subscription" where "organizationId"='${org.id}' group by 1,2 having count(*)>1) d`);
  await dupes("customers (integration, externalCustomerId)", `select count(*)::bigint as n from (select "integrationId","externalCustomerId" from "Customer" where "organizationId"='${org.id}' group by 1,2 having count(*)>1) d`);
  await dupes("order lines (integration, externalOrderId, externalSubscriptionId)", `select count(*)::bigint as n from (select "integrationId","externalOrderId","externalSubscriptionId" from "SubscriptionOrder" where "organizationId"='${org.id}' group by 1,2,3 having count(*)>1) d`);
  await dupes("journey cycles (journeyId, externalOrderId)", `select count(*)::bigint as n from (select "journeyId","externalOrderId" from "JourneyCycle" where "organizationId"='${org.id}' group by 1,2 having count(*)>1) d`);
  await dupes("journeys (subscriptionId, sequence)", `select count(*)::bigint as n from (select "subscriptionId","sequence" from "SubscriptionJourney" where "organizationId"='${org.id}' group by 1,2 having count(*)>1) d`);
  await dupes("latestJourneyId", `select count(*)::bigint as n from (select "latestJourneyId" from "Subscription" where "organizationId"='${org.id}' and "latestJourneyId" is not null group by 1 having count(*)>1) d`);
  await dupes("rule milestoneKey", `select count(*)::bigint as n from (select "milestoneKey" from "AutomationRule" where "organizationId"='${org.id}' and "milestoneKey" is not null group by 1 having count(*)>1) d`);
  await dupes("markers (integration, externalVariantId)", `select count(*)::bigint as n from (select "integrationId","externalVariantId" from "FulfillmentMarker" where "organizationId"='${org.id}' group by 1,2 having count(*)>1) d`);
  await dupes("action liveKey", `select count(*)::bigint as n from (select "liveKey" from "AutomationAction" where "organizationId"='${org.id}' and "liveKey" is not null group by 1 having count(*)>1) d`);

  // latestJourneyId must point at the highest-sequence journey of its subscription
  const badLatest = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from "Subscription" s join "SubscriptionJourney" j on j.id = s."latestJourneyId" where s."organizationId"='${org.id}' and j.sequence < (select max(sequence) from "SubscriptionJourney" x where x."subscriptionId"=s.id)`);
  add("latestJourneyId = highest sequence", Number(badLatest[0].n) === 0, `${badLatest[0].n} mismatches`);
  // successfulCycles must equal the number of cycle rows per journey
  const badCounts = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from "SubscriptionJourney" j where j."organizationId"='${org.id}' and j."successfulCycles" <> (select count(*) from "JourneyCycle" c where c."journeyId"=j.id)`);
  add("successfulCycles = cycle evidence", Number(badCounts[0].n) === 0, `${badCounts[0].n} journeys disagree`);
}

main()
  .then(() => {
    const w = Math.max(...lines.map((l) => l.check.length));
    for (const l of lines) console.log(`${l.ok === null ? "·" : l.ok ? "✔" : "✖"} ${l.check.padEnd(w)}  ${l.detail}`);
    const failed = lines.filter((l) => l.ok === false).length;
    console.log(`\n${failed === 0 ? "INTEGRITY OK" : `INTEGRITY: ${failed} check(s) FAILED`}`);
    process.exitCode = failed === 0 ? 0 : 1;
  })
  .catch((e) => {
    console.error("integrity check crashed:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

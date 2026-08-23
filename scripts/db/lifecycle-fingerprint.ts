/**
 * Lifecycle fingerprint — captures everything that must NOT change when reward configuration changes:
 * subscriptions, subscription orders, programme mappings, journeys, journey cycles, latest journeys.
 *
 *   npx dotenv -e .env.local -- tsx scripts/db/lifecycle-fingerprint.ts capture <org-slug> <out.json>
 *   npx dotenv -e .env.local -- tsx scripts/db/lifecycle-fingerprint.ts compare <before.json> <after.json>
 *
 * Read-only. Writes only the JSON file you name.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

type Snapshot = {
  capturedAt: string;
  org: string;
  subscriptions: string[];
  orders: string[];
  mappings: string[];
  journeys: string[];
  cycles: string[];
  hashes: Record<string, string>;
};

const h = (lines: string[]) => createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);

async function capture(slug: string, out: string) {
  const prisma = new PrismaClient();
  const org = await prisma.organization.findUniqueOrThrow({ where: { slug } });
  const O = { organizationId: org.id };
  const subs = (await prisma.subscription.findMany({ where: O, orderBy: { externalSubscriptionId: "asc" } })).map((s) => `${s.externalSubscriptionId}|${s.status}|${s.mappingStatus}|${s.latestJourneyId ?? "—"}|${s.nextChargeDate ?? "—"}|${s.externalProductId}/${s.externalVariantId}`);
  const orders = (await prisma.subscriptionOrder.findMany({ where: O, orderBy: [{ externalSubscriptionId: "asc" }, { externalOrderId: "asc" }] })).map((o) => `${o.externalSubscriptionId}|${o.externalOrderId}|${o.orderKind}|${o.processedAt.toISOString()}|${o.externalProductId}/${o.externalVariantId}|${o.subscriptionId ?? "—"}`);
  const mappings = (await prisma.subscriptionProgramProduct.findMany({ where: O, include: { program: { select: { name: true } }, product: { select: { externalProductId: true } } }, orderBy: [{ programId: "asc" }, { productId: "asc" }] })).map((m) => `${m.program.name}|${m.product.externalProductId}|${m.variantScope}`);
  const journeys = (await prisma.subscriptionJourney.findMany({ where: O, include: { program: { select: { name: true } }, subscription: { select: { externalSubscriptionId: true } } }, orderBy: { id: "asc" } })).map((j) => `${j.id}|${j.subscription.externalSubscriptionId}|seq${j.sequence}|${j.program.name}|cycles${j.successfulCycles}|${j.startedAt.toISOString()}|${j.endedAt?.toISOString() ?? "—"}|${j.endReason ?? "—"}`);
  const cycles = (await prisma.journeyCycle.findMany({ where: O, orderBy: [{ journeyId: "asc" }, { cycleNumber: "asc" }] })).map((c) => `${c.journeyId}|${c.cycleNumber}|${c.externalOrderId}|${c.processedAt.toISOString()}`);
  const snap: Snapshot = { capturedAt: new Date().toISOString(), org: slug, subscriptions: subs, orders, mappings, journeys, cycles, hashes: {} };
  snap.hashes = { subscriptions: h(subs), orders: h(orders), mappings: h(mappings), journeys: h(journeys), cycles: h(cycles) };
  writeFileSync(out, JSON.stringify(snap));
  console.log(`captured ${slug}: subscriptions=${subs.length} orders=${orders.length} mappings=${mappings.length} journeys=${journeys.length} cycles=${cycles.length}`);
  console.log("hashes", JSON.stringify(snap.hashes));
  await prisma.$disconnect();
}

function compare(aFile: string, bFile: string) {
  const a = JSON.parse(readFileSync(aFile, "utf8")) as Snapshot;
  const b = JSON.parse(readFileSync(bFile, "utf8")) as Snapshot;
  let allSame = true;
  for (const key of ["subscriptions", "orders", "mappings", "journeys", "cycles"] as const) {
    const same = a.hashes[key] === b.hashes[key];
    if (!same) allSame = false;
    const setA = new Set(a[key]);
    const setB = new Set(b[key]);
    const removed = a[key].filter((x) => !setB.has(x));
    const added = b[key].filter((x) => !setA.has(x));
    console.log(`${same ? "✔" : "✖"} ${key}: ${a[key].length} → ${b[key].length} (${removed.length} removed/changed, ${added.length} added/changed)`);
    if (!same) {
      for (const r of removed.slice(0, 40)) console.log(`    - ${r}`);
      for (const r of added.slice(0, 40)) console.log(`    + ${r}`);
      if (removed.length > 40 || added.length > 40) console.log(`    … (${removed.length} removed, ${added.length} added in total)`);
    }
  }
  console.log(allSame ? "\nLIFECYCLE UNCHANGED" : "\nLIFECYCLE DIFFERS (see above)");
  process.exitCode = allSame ? 0 : 3;
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "capture" && a && b) capture(a, b).catch((e) => { console.error(e); process.exitCode = 1; });
else if (cmd === "compare" && a && b) compare(a, b);
else { console.error("usage: capture <org-slug> <out.json> | compare <before.json> <after.json>"); process.exitCode = 2; }

/**
 * Development seed — realistic demo data for the UI.
 *
 *   npm run db:seed
 *
 * Creates (idempotently — existing demo orgs/users are removed first):
 *   - demo user  demo@subscription-ops.local / demo-password-123   (OWNER of both orgs)
 *   - viewer user viewer@subscription-ops.local / viewer-password-123 (VIEWER of the demo org)
 *   - "Ancient Extracts Demo": Recharge integration (DRY_RUN), 4 programs, 3 markers,
 *     3 rules, 20 customers, 30 subscriptions at various journey states, actions,
 *     activity and exceptions
 *   - "Northwind Botanicals" (tiny second tenant for multi-tenancy)
 *
 * Uses the raw PrismaClient directly (no app singleton — this runs outside Next).
 */
import { PrismaClient, type ActionStatus, type SubscriptionStatus } from "@prisma/client";
import { hashPassword } from "better-auth/crypto";

const prisma = new PrismaClient();

const DEMO_ORG_SLUG = "ancient-extracts-demo";
const SECOND_ORG_SLUG = "northwind-botanicals";
const DEMO_EMAIL = "demo@subscription-ops.local";
const VIEWER_EMAIL = "viewer@subscription-ops.local";
const TZ = "Europe/London";

// ── helpers ──────────────────────────────────────────────────────────────────
const DAY = 86_400_000;
const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);
const daysAhead = (n: number) => new Date(now.getTime() + n * DAY);
/** YYYY-MM-DD in the org timezone */
const dateOnly = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
/** local midnight of a YYYY-MM-DD in TZ — good enough for London in a seed (approximate DST) */
const localMidnight = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, d, 0, 0, 0);
  // London offset: BST (UTC+1) roughly Apr–Oct
  const month = m;
  const offsetHours = month >= 4 && month <= 10 ? 1 : 0;
  return new Date(utc - offsetHours * 3_600_000);
};
let extId = 400_000;
const nextId = () => String(++extId);

const CUSTOMERS = [
  ["Sarah", "Johnson", "sarah.johnson"],
  ["James", "Whitfield", "james.whitfield"],
  ["Priya", "Nair", "priya.nair"],
  ["Tom", "Okafor", "tom.okafor"],
  ["Eleanor", "Hughes", "eleanor.hughes"],
  ["Daniel", "Kowalski", "daniel.kowalski"],
  ["Amara", "Osei", "amara.osei"],
  ["Lucy", "Bennett", "lucy.bennett"],
  ["Hassan", "Rahman", "hassan.rahman"],
  ["Georgia", "Mills", "georgia.mills"],
  ["Oliver", "Brennan", "oliver.brennan"],
  ["Mei", "Tanaka", "mei.tanaka"],
  ["Callum", "Reid", "callum.reid"],
  ["Isabel", "Moreno", "isabel.moreno"],
  ["Nathan", "Price", "nathan.price"],
  ["Chloe", "Davenport", "chloe.davenport"],
  ["Arjun", "Mehta", "arjun.mehta"],
  ["Rosie", "Lindqvist", "rosie.lindqvist"],
  ["Ben", "Fletcher", "ben.fletcher"],
  ["Hannah", "Adeyemi", "hannah.adeyemi"],
] as const;

async function resetDemo() {
  await prisma.organization.deleteMany({ where: { slug: { in: [DEMO_ORG_SLUG, SECOND_ORG_SLUG] } } });
  await prisma.user.deleteMany({ where: { email: { in: [DEMO_EMAIL, VIEWER_EMAIL] } } });
}

async function createUser(email: string, name: string, password: string) {
  const user = await prisma.user.create({ data: { email, name, emailVerified: true } });
  await prisma.account.create({
    data: { userId: user.id, providerId: "credential", issuer: "local:credential", accountId: user.id, password: await hashPassword(password) },
  });
  return user;
}

async function seedDemoOrg(ownerId: string, viewerId: string) {
  const org = await prisma.organization.create({
    data: { name: "Ancient Extracts Demo", slug: DEMO_ORG_SLUG, timezone: TZ, currency: "GBP", markerLeadHours: 72 },
  });
  const O = { organizationId: org.id };
  await prisma.organizationMembership.createMany({
    data: [
      { ...O, userId: ownerId, role: "OWNER" },
      { ...O, userId: viewerId, role: "VIEWER" },
    ],
  });

  const integration = await prisma.integration.create({
    data: {
      ...O,
      provider: "RECHARGE",
      status: "CONNECTED",
      externalStoreId: "ancient-extracts-demo.myshopify.com",
      displayName: "Ancient Extracts (Recharge)",
      encryptedCredentials: "v1.seed.AAAA.AAAA.AAAA", // placeholder, never decrypted
      automationMode: "DRY_RUN",
      capabilitiesJson: {
        store: "available",
        customers: "available",
        products: "available",
        orders: "available",
        subscriptions: "read_write",
        onetimes: "available",
        webhooks: "available",
        charges: "available",
        credits: "unavailable",
        events: "unavailable",
        customer_sessions: "unavailable",
      },
      capabilitiesCheckedAt: daysAgo(0.1),
      lastSuccessfulSyncAt: daysAgo(0.05),
    },
  });
  const I = { ...O, integrationId: integration.id };

  // ── products & variants ──
  async function product(title: string, variants: { title: string; sku: string; price: string }[], type: "SUBSCRIPTION_PRODUCT" | "FULFILMENT_MARKER" = "SUBSCRIPTION_PRODUCT") {
    const p = await prisma.product.create({ data: { ...I, externalProductId: nextId(), title, type, lastSyncedAt: now } });
    const vs = [];
    for (const v of variants) {
      vs.push(await prisma.productVariant.create({ data: { ...O, productId: p.id, externalVariantId: nextId(), title: v.title, sku: v.sku, price: v.price } }));
    }
    return { p, vs };
  }

  const mm = await product("Morning Magic", [
    { title: "30 servings", sku: "MM-30", price: "34.00" },
    { title: "60 servings", sku: "MM-60", price: "62.00" },
  ]);
  const kcups = await product("Morning Magic K-Cups", [
    { title: "12 pods", sku: "MMK-12", price: "19.00" },
    { title: "24 pods", sku: "MMK-24", price: "35.00" },
  ]);
  const cacao = await product("Ceremonial Cacao", [
    { title: "Classic 250g", sku: "CACAO-250", price: "29.00" },
    { title: "Spiced 250g", sku: "CACAO-SP-250", price: "31.00" },
  ]);
  const shilajit = await product("Himalayan Shilajit", [{ title: "Resin 15g", sku: "SHIL-15", price: "44.00" }]);
  const ube = await product("Ube Latte", [{ title: "200g", sku: "UBE-200", price: "24.00" }]); // deliberately unmapped
  const mkMM2 = await product("Morning Magic 2", [{ title: "Default", sku: "MM-CYCLE-02", price: "0.00" }], "FULFILMENT_MARKER");
  const mkMM6 = await product("Morning Magic 6", [{ title: "Default", sku: "MM-CYCLE-06", price: "0.00" }], "FULFILMENT_MARKER");
  const mkCacao3 = await product("Cacao 3", [{ title: "Default", sku: "CACAO-CYCLE-03", price: "0.00" }], "FULFILMENT_MARKER");

  // ── programs ──
  async function program(name: string, description: string, products: { productId: string; variantId?: string }[]) {
    const pr = await prisma.subscriptionProgram.create({ data: { ...O, name, description } });
    for (const m of products) {
      await prisma.subscriptionProgramProduct.create({
        data: { ...O, programId: pr.id, productId: m.productId, variantId: m.variantId, variantScope: m.variantId ?? "*" },
      });
    }
    return pr;
  }
  const progMM = await program("Morning Magic Powder", "All Morning Magic powder sizes share one gift journey.", [{ productId: mm.p.id }]);
  const progK = await program("Morning Magic K-Cups", "Pods have their own lifecycle.", [{ productId: kcups.p.id }]);
  const progCacao = await program("Cacao", "Ceremonial cacao, both flavours.", [{ productId: cacao.p.id }]);
  const progShil = await program("Shilajit", "No milestone gifts configured yet.", [{ productId: shilajit.p.id }]);

  // ── markers ──
  const mk = (name: string, description: string, prod: typeof mkMM2) => ({
    ...I,
    name,
    description,
    variantId: prod.vs[0].id,
    externalVariantId: prod.vs[0].externalVariantId,
    externalProductId: prod.p.externalProductId,
    title: prod.p.title,
    sku: prod.vs[0].sku,
    source: "CATALOGUE" as const,
  });
  const markerMM2 = await prisma.fulfillmentMarker.create({ data: mk("Morning Magic Cycle 2", "Fulfilment adds the free electric whisk for second Morning Magic delivery.", mkMM2) });
  const markerMM6 = await prisma.fulfillmentMarker.create({ data: mk("Morning Magic Cycle 6", "Six-month loyalty gift: ceramic cup.", mkMM6) });
  const markerCacao3 = await prisma.fulfillmentMarker.create({ data: mk("Cacao Cycle 3", "Third cacao delivery includes the wooden whisk.", mkCacao3) });

  // ── reward items + schedules (Phase 4b: reusable milestone configuration; rules are legacy) ──
  const whisk = await prisma.rewardItem.create({ data: { ...O, name: "Whisk", operationalDescription: "Include the electric whisk", createdById: ownerId } });
  const cup = await prisma.rewardItem.create({ data: { ...O, name: "Cup", operationalDescription: "Include the ceramic cup", createdById: ownerId } });
  await prisma.fulfillmentMarker.update({ where: { id: markerMM2.id }, data: { rewardItemId: whisk.id, operationalNote: "Include whisk" } });
  await prisma.fulfillmentMarker.update({ where: { id: markerMM6.id }, data: { rewardItemId: cup.id, operationalNote: "Include cup" } });
  await prisma.fulfillmentMarker.update({ where: { id: markerCacao3.id }, data: { rewardItemId: whisk.id, operationalNote: "Include whisk" } });
  const schedMM = await prisma.rewardSchedule.create({ data: { ...O, name: "Morning Magic rewards", description: "Demo: whisk at delivery 2, cup at delivery 6.", status: "READY", createdById: ownerId } });
  const msMM2 = await prisma.rewardScheduleMilestone.create({ data: { ...O, scheduleId: schedMM.id, cycleNumber: 2, rewardItemId: whisk.id, executionMode: "UPCOMING_RENEWAL", eligibilityScope: "PER_SUBSCRIPTION" } });
  const msMM6 = await prisma.rewardScheduleMilestone.create({ data: { ...O, scheduleId: schedMM.id, cycleNumber: 6, rewardItemId: cup.id, executionMode: "UPCOMING_RENEWAL", eligibilityScope: "PER_SUBSCRIPTION", notes: "Awaiting stock confirmation." } });
  const schedCacao = await prisma.rewardSchedule.create({ data: { ...O, name: "Cacao rewards", description: "Demo: whisk at delivery 3.", status: "READY", createdById: ownerId } });
  const msCacao3 = await prisma.rewardScheduleMilestone.create({ data: { ...O, scheduleId: schedCacao.id, cycleNumber: 3, rewardItemId: whisk.id, executionMode: "UPCOMING_RENEWAL", eligibilityScope: "PER_SUBSCRIPTION" } });
  await prisma.subscriptionProgram.update({ where: { id: progMM.id }, data: { rewardScheduleId: schedMM.id, rewardScheduleAssignedAt: now } });
  await prisma.subscriptionProgram.update({ where: { id: progCacao.id }, data: { rewardScheduleId: schedCacao.id, rewardScheduleAssignedAt: now } });
  await prisma.programMilestoneMarker.createMany({
    data: [
      { ...O, programId: progMM.id, rewardScheduleMilestoneId: msMM2.id, fulfillmentMarkerId: markerMM2.id },
      { ...O, programId: progMM.id, rewardScheduleMilestoneId: msMM6.id, fulfillmentMarkerId: markerMM6.id },
      { ...O, programId: progCacao.id, rewardScheduleMilestoneId: msCacao3.id, fulfillmentMarkerId: markerCacao3.id },
    ],
  });
  // milestone ids used by the demo actions below
  const ruleMM2 = { id: msMM2.id, programId: progMM.id };
  const ruleCacao3 = { id: msCacao3.id, programId: progCacao.id };

  // ── customers ──
  const customers = [];
  for (const [first, last, handle] of CUSTOMERS) {
    customers.push(
      await prisma.customer.create({ data: { ...I, externalCustomerId: nextId(), firstName: first, lastName: last, email: `${handle}@example.com`, lastSyncedAt: now } }),
    );
  }

  // ── subscriptions ──
  type Spec = {
    customer: number;
    product: { p: { id: string; externalProductId: string; title: string }; vs: { id: string; externalVariantId: string; title: string; sku: string | null; price: unknown }[] };
    variant: number;
    program: { id: string } | null;
    cycles: number; // completed successful cycles in current journey
    status?: SubscriptionStatus;
    intervalDays?: number;
    nextIn?: number; // days until next charge
    previous?: { program: { id: string }; product: typeof mm; cycles: number }; // swapped-from journey
  };
  const specs: Spec[] = [
    { customer: 0, product: mm, variant: 0, program: progMM, cycles: 1, nextIn: 2 }, // Sarah — MM cycle 2 due in 2 days: ATTACHED
    { customer: 1, product: cacao, variant: 0, program: progCacao, cycles: 2, nextIn: 5 }, // James — Cacao 3 planned
    { customer: 2, product: mm, variant: 1, program: progMM, cycles: 1, nextIn: 12 }, // Priya — MM planned
    { customer: 3, product: mm, variant: 0, program: progMM, cycles: 3, nextIn: 9 },
    { customer: 4, product: kcups, variant: 0, program: progK, cycles: 2, nextIn: 4 },
    { customer: 5, product: shilajit, variant: 0, program: progShil, cycles: 5, nextIn: 7 },
    { customer: 6, product: cacao, variant: 1, program: progCacao, cycles: 0, nextIn: 20 },
    { customer: 7, product: mm, variant: 0, program: progMM, cycles: 2, nextIn: 18 }, // fulfilled cycle-2 marker in the past
    { customer: 8, product: mm, variant: 0, program: progMM, cycles: 1, nextIn: 1 }, // Hassan — attach failed → exception
    { customer: 9, product: cacao, variant: 0, program: progCacao, cycles: 1, status: "PAUSED", nextIn: 45 },
    { customer: 10, product: kcups, variant: 1, program: progK, cycles: 4, nextIn: 11 },
    { customer: 11, product: mm, variant: 1, program: progMM, cycles: 5, nextIn: 6 }, // approaching cycle 6 (rule disabled)
    { customer: 12, product: ube, variant: 0, program: null, cycles: 0, nextIn: 14 }, // UNMAPPED
    { customer: 13, product: cacao, variant: 0, program: progCacao, cycles: 2, nextIn: 1 }, // attached cacao 3 tomorrow
    { customer: 14, product: mm, variant: 0, program: progMM, cycles: 0, nextIn: 27 },
    { customer: 15, product: shilajit, variant: 0, program: progShil, cycles: 2, status: "CANCELLED", nextIn: -3 },
    { customer: 16, product: cacao, variant: 1, program: progCacao, cycles: 1, previous: { program: progMM, product: mm, cycles: 2 }, nextIn: 16 }, // swapped MM → Cacao
    { customer: 17, product: mm, variant: 0, program: progMM, cycles: 7, nextIn: 3 },
    { customer: 18, product: kcups, variant: 0, program: progK, cycles: 1, status: "PAUSED", nextIn: 60 },
    { customer: 19, product: mm, variant: 1, program: progMM, cycles: 1, nextIn: 22 },
    { customer: 0, product: shilajit, variant: 0, program: progShil, cycles: 1, nextIn: 2 }, // Sarah's second sub, same address, different date
    { customer: 2, product: cacao, variant: 0, program: progCacao, cycles: 3, nextIn: 8 },
    { customer: 4, product: mm, variant: 0, program: progMM, cycles: 2, status: "CANCELLED", nextIn: -10 },
    { customer: 6, product: mm, variant: 0, program: progMM, cycles: 1, nextIn: 30 },
    { customer: 8, product: kcups, variant: 1, program: progK, cycles: 0, nextIn: 25 },
    { customer: 10, product: cacao, variant: 1, program: progCacao, cycles: 4, nextIn: 13 },
    { customer: 12, product: mm, variant: 0, program: progMM, cycles: 3, status: "CANCELLED", nextIn: -30 },
    { customer: 14, product: cacao, variant: 0, program: progCacao, cycles: 0, status: "PAUSED", nextIn: 90 },
    { customer: 16, product: shilajit, variant: 0, program: progShil, cycles: 6, nextIn: 10 },
    { customer: 18, product: mm, variant: 0, program: progMM, cycles: 1, nextIn: 40 },
  ];

  const subs: { id: string; journeyId: string | null; programId: string | null; cycles: number; nextDate: string; spec: Spec; customerName: string }[] = [];

  for (const [i, spec] of specs.entries()) {
    const customer = customers[spec.customer];
    const status: SubscriptionStatus = spec.status ?? "ACTIVE";
    const variant = spec.product.vs[spec.variant];
    const intervalDays = spec.intervalDays ?? 30;
    const nextChargeAt = daysAhead(spec.nextIn ?? 14);
    const nextDate = dateOnly(nextChargeAt);
    const totalCycles = spec.cycles + (spec.previous?.cycles ?? 0);
    const createdAt = daysAgo(totalCycles * intervalDays + (spec.nextIn ?? 14) - intervalDays + 1);

    const sub = await prisma.subscription.create({
      data: {
        ...I,
        customerId: customer.id,
        externalSubscriptionId: nextId(),
        externalCustomerId: customer.externalCustomerId,
        externalAddressId: `addr-${customer.externalCustomerId}`,
        status,
        externalStatus: status === "PAUSED" ? "active" : status.toLowerCase(),
        mappingStatus: spec.program ? "MAPPED" : "UNMAPPED",
        productId: spec.product.p.id,
        variantId: variant.id,
        externalProductId: spec.product.p.externalProductId,
        externalVariantId: variant.externalVariantId,
        productTitleSnapshot: spec.product.p.title,
        variantTitleSnapshot: variant.title,
        skuSnapshot: variant.sku,
        quantity: 1,
        price: variant.price as string,
        intervalUnit: "day",
        intervalFrequency: intervalDays,
        nextChargeDate: status === "CANCELLED" ? null : nextDate,
        nextChargeAt: status === "CANCELLED" ? null : localMidnight(nextDate),
        externalCreatedAt: createdAt,
        cancelledAt: status === "CANCELLED" ? daysAgo(2) : null,
        lastSyncedAt: now,
      },
    });

    let journeyId: string | null = null;
    if (spec.program) {
      let seq = 1;
      // previous (swapped-from) journey
      if (spec.previous) {
        const prevStart = createdAt;
        const prev = await prisma.subscriptionJourney.create({
          data: {
            ...O,
            subscriptionId: sub.id,
            programId: spec.previous.program.id,
            productId: spec.previous.product.p.id,
            variantId: spec.previous.product.vs[0].id,
            externalProductId: spec.previous.product.p.externalProductId,
            externalVariantId: spec.previous.product.vs[0].externalVariantId,
            sequence: seq++,
            startedAt: prevStart,
            endedAt: daysAgo(spec.cycles * intervalDays + 2),
            endReason: "PROGRAM_CHANGE",
            successfulCycles: spec.previous.cycles,
          },
        });
        for (let c = 1; c <= spec.previous.cycles; c++) {
          await prisma.journeyCycle.create({
            data: { ...O, journeyId: prev.id, cycleNumber: c, externalOrderId: nextId(), orderKind: c === 1 ? "CHECKOUT" : "RECURRING", processedAt: new Date(prevStart.getTime() + (c - 1) * intervalDays * DAY), source: "BACKFILL" },
          });
        }
        await prisma.automationAction.create({
          data: {
            ...I,
            ruleId: null,
            rewardScheduleMilestoneId: ruleMM2.id,
            programId: ruleMM2.programId,
            subscriptionId: sub.id,
            journeyId: prev.id,
            fulfillmentMarkerId: markerMM2.id,
            targetCycle: 2,
            status: "FULFILLED",
            targetChargeDate: dateOnly(new Date(prevStart.getTime() + intervalDays * DAY)),
            executedAt: new Date(prevStart.getTime() + intervalDays * DAY - 3 * DAY),
            externalObjectType: "recharge_onetime",
            externalObjectId: nextId(),
            createdAt: prevStart,
          },
        });
      }
      const startedAt = spec.previous ? daysAgo(spec.cycles * intervalDays + 2) : createdAt;
      const journey = await prisma.subscriptionJourney.create({
        data: {
          ...O,
          subscriptionId: sub.id,
          programId: spec.program.id,
          productId: spec.product.p.id,
          variantId: variant.id,
          externalProductId: spec.product.p.externalProductId,
          externalVariantId: variant.externalVariantId,
          sequence: seq,
          startedAt,
          endedAt: status === "CANCELLED" ? daysAgo(2) : null,
          endReason: status === "CANCELLED" ? "CANCELLED" : null,
          successfulCycles: spec.cycles,
        },
      });
      journeyId = journey.id;
      await prisma.subscription.update({ where: { id: sub.id }, data: { latestJourneyId: journey.id } });
      for (let c = 1; c <= spec.cycles; c++) {
        const processedAt = new Date(nextChargeAt.getTime() - (spec.cycles - c + 1) * intervalDays * DAY);
        await prisma.journeyCycle.create({
          data: { ...O, journeyId: journey.id, cycleNumber: c, externalOrderId: nextId(), orderKind: c === 1 && !spec.previous ? "CHECKOUT" : "RECURRING", processedAt, source: c === spec.cycles && i % 3 === 0 ? "WEBHOOK" : "BACKFILL" },
        });
      }
    }
    subs.push({ id: sub.id, journeyId, programId: spec.program?.id ?? null, cycles: spec.cycles, nextDate, spec, customerName: `${customer.firstName} ${customer.lastName}` });
  }

  // ── actions for the current journeys (rule matching: next cycle == rule cycle) ──
  const act = async (
    s: (typeof subs)[number],
    milestoneId: string,
    markerId: string,
    status: ActionStatus,
    extra: Partial<{ executedAt: Date; externalObjectId: string; lastError: string; cancelReason: string; createdAt: Date }> = {},
  ) => {
    const target = s.cycles + 1;
    const targetChargeAt = localMidnight(s.nextDate);
    return prisma.automationAction.create({
      data: {
        ...I,
        ruleId: null,
        rewardScheduleMilestoneId: milestoneId,
        programId: s.programId ?? undefined,
        subscriptionId: s.id,
        journeyId: s.journeyId!,
        fulfillmentMarkerId: markerId,
        targetCycle: target,
        status,
        liveKey: ["PLANNED", "EXECUTING", "ATTACHED", "FULFILLED", "FAILED"].includes(status) ? `${s.journeyId}:${target}:${markerId}` : null,
        targetChargeDate: s.nextDate,
        targetChargeAt,
        executeAfter: new Date(targetChargeAt.getTime() - 72 * 3_600_000),
        executedAt: extra.executedAt ?? null,
        externalObjectType: extra.externalObjectId ? "recharge_onetime" : null,
        externalObjectId: extra.externalObjectId ?? null,
        externalChargeDate: extra.externalObjectId ? s.nextDate : null,
        externalAddressId: extra.externalObjectId ? `addr-${s.spec.customer}` : null,
        attemptCount: status === "FAILED" ? 1 : extra.executedAt ? 1 : 0,
        lastError: extra.lastError ?? null,
        lastErrorAt: extra.lastError ? daysAgo(0.2) : null,
        cancelReason: extra.cancelReason ?? null,
        dryRun: false,
        createdAt: extra.createdAt ?? daysAgo(1),
      },
    });
  };

  const actions: Record<string, string> = {};
  for (const s of subs) {
    if (!s.journeyId || s.spec.status === "CANCELLED") continue;
    const next = s.cycles + 1;
    if (s.programId === progMM.id && next === 2) {
      const idx = s.spec.customer;
      if (idx === 0) actions.sarah = (await act(s, ruleMM2.id, markerMM2.id, "ATTACHED", { executedAt: daysAgo(0.5), externalObjectId: nextId() })).id;
      else if (idx === 8) actions.hassan = (await act(s, ruleMM2.id, markerMM2.id, "FAILED", { lastError: "Recharge returned 404: variant for marker 'Morning Magic 2' not found" })).id;
      else if (s.spec.status === "PAUSED") await act(s, ruleMM2.id, markerMM2.id, "CANCELLED", { cancelReason: "Subscription paused before target cycle" });
      else await act(s, ruleMM2.id, markerMM2.id, "PLANNED");
    }
    if (s.programId === progCacao.id && next === 3) {
      if (s.spec.customer === 13) await act(s, ruleCacao3.id, markerCacao3.id, "ATTACHED", { executedAt: daysAgo(1.8), externalObjectId: nextId() });
      else if (s.spec.status === "PAUSED") await act(s, ruleCacao3.id, markerCacao3.id, "CANCELLED", { cancelReason: "Subscription paused before target cycle" });
      else await act(s, ruleCacao3.id, markerCacao3.id, "PLANNED");
    }
  }
  // historical fulfilled actions for MM subscriptions that are past cycle 2
  for (const s of subs) {
    if (!s.journeyId || s.programId !== progMM.id || s.cycles < 2) continue;
    const cycle2 = await prisma.journeyCycle.findFirst({ where: { journeyId: s.journeyId, cycleNumber: 2 } });
    if (!cycle2) continue;
    const date = dateOnly(cycle2.processedAt);
    await prisma.automationAction.create({
      data: {
        ...I,
        ruleId: null,
        rewardScheduleMilestoneId: ruleMM2.id,
        programId: ruleMM2.programId,
        subscriptionId: s.id,
        journeyId: s.journeyId,
        fulfillmentMarkerId: markerMM2.id,
        targetCycle: 2,
        status: "FULFILLED",
        liveKey: `${s.journeyId}:2:${markerMM2.id}`,
        targetChargeDate: date,
        targetChargeAt: localMidnight(date),
        executeAfter: new Date(cycle2.processedAt.getTime() - 72 * 3_600_000),
        executedAt: new Date(cycle2.processedAt.getTime() - 70 * 3_600_000),
        externalObjectType: "recharge_onetime",
        externalObjectId: nextId(),
        externalChargeDate: date,
        fulfilledByCycleId: cycle2.id,
        attemptCount: 1,
        createdAt: new Date(cycle2.processedAt.getTime() - 30 * DAY),
      },
    });
  }

  // ── exceptions ──
  const hassan = subs.find((s) => s.spec.customer === 8 && s.programId === progMM.id)!;
  await prisma.exception.create({
    data: {
      ...O,
      severity: "CRITICAL",
      type: "MARKER_PRODUCT_MISSING",
      title: "Fulfilment marker product not found in Recharge",
      description: "Attaching 'Morning Magic 2' failed: the configured variant (SKU MM-CYCLE-02) returned 404. The marker may have been deleted or unpublished. Re-map the marker to a live variant, then retry the action.",
      integrationId: integration.id,
      subscriptionId: hassan.id,
      journeyId: hassan.journeyId,
      actionId: actions.hassan,
      detectedAt: daysAgo(0.2),
      metadataJson: { httpStatus: 404, externalVariantId: mkMM2.vs[0].externalVariantId },
    },
  });
  const unmapped = subs.find((s) => !s.programId)!;
  await prisma.exception.create({
    data: {
      ...O,
      severity: "WARNING",
      type: "PRODUCT_MAPPING_MISSING",
      title: "Active subscription product is not assigned to a program",
      description: "'Ube Latte' is not part of any subscription program, so no delivery cycles are counted and no rules apply. Assign it to a program (or create one) to start tracking.",
      integrationId: integration.id,
      subscriptionId: unmapped.id,
      detectedAt: daysAgo(2),
    },
  });
  const sarah = subs.find((s) => s.spec.customer === 0 && s.programId === progMM.id)!;
  await prisma.exception.create({
    data: {
      ...O,
      severity: "WARNING",
      type: "CHARGE_DATE_MOVED",
      title: "Subscription rescheduled after marker was queued",
      description: `Sarah Johnson moved the Morning Magic charge; the queued marker was moved to ${sarah.nextDate} to match. No action needed.`,
      status: "RESOLVED",
      autoResolved: true,
      subscriptionId: sarah.id,
      actionId: actions.sarah,
      detectedAt: daysAgo(0.4),
      resolvedAt: daysAgo(0.4),
    },
  });

  // ── activity ──
  const A = (eventType: string, entityType: "ORGANIZATION" | "INTEGRATION" | "RULE" | "REWARD_SCHEDULE" | "SUBSCRIPTION" | "ACTION" | "EXCEPTION" | "JOURNEY", entityId: string, summary: string, createdAt: Date, actorType: "USER" | "SYSTEM" | "INTEGRATION" = "SYSTEM", actorId: string | null = null) =>
    prisma.activityLog.create({ data: { ...O, actorType, actorId, eventType, entityType, entityId, summary, createdAt } });

  await A("ORGANIZATION_CREATED", "ORGANIZATION", org.id, 'Organisation "Ancient Extracts Demo" created', daysAgo(45), "USER", ownerId);
  await A("INTEGRATION_CONNECTED", "INTEGRATION", integration.id, "Recharge connected — Ancient Extracts (Recharge). All required capabilities available.", daysAgo(44), "USER", ownerId);
  await A("SYNC_COMPLETED", "INTEGRATION", integration.id, "Initial import complete: 30 subscriptions (22 active, 8 inactive), 20 customers, 8 products. Historical cycles calculated.", daysAgo(44));
  await A("REWARD_SCHEDULE_CREATED", "REWARD_SCHEDULE", schedMM.id, 'Reward schedule "Morning Magic rewards" created (draft)', daysAgo(41), "USER", ownerId);
  await A("REWARD_SCHEDULE_READY", "REWARD_SCHEDULE", schedMM.id, 'Reward schedule "Morning Magic rewards" marked ready (delivery 2 → Whisk, delivery 6 → Cup; used by Morning Magic Powder)', daysAgo(40), "USER", ownerId);
  await A("REWARD_SCHEDULE_READY", "REWARD_SCHEDULE", schedCacao.id, 'Reward schedule "Cacao rewards" marked ready (delivery 3 → Whisk; used by Cacao)', daysAgo(25), "USER", ownerId);
  await A("CYCLE_COMPLETED", "JOURNEY", sarah.journeyId!, "Sarah Johnson · Morning Magic: delivery 1 processed (order recurring)", daysAgo(28));
  await A("MARKER_QUEUED", "ACTION", actions.sarah, "Planned 'Morning Magic Cycle 2' for Sarah Johnson · Morning Magic, delivery 2 on " + sarah.nextDate, daysAgo(28));
  await A("MARKER_MOVED", "ACTION", actions.sarah, "Moved queued marker for Sarah Johnson · Morning Magic to " + sarah.nextDate + " after the subscription was rescheduled", daysAgo(0.4));
  await A("MARKER_ATTACHED", "ACTION", actions.sarah, "Attached 'Morning Magic 2' to Sarah Johnson's upcoming Morning Magic shipment (" + sarah.nextDate + ")", daysAgo(0.5));
  await A("MARKER_QUEUED", "ACTION", actions.hassan, "Planned 'Morning Magic Cycle 2' for Hassan Rahman · Morning Magic, delivery 2 on " + hassan.nextDate, daysAgo(29));
  await A("ACTION_FAILED", "ACTION", actions.hassan, "Attaching 'Morning Magic 2' for Hassan Rahman failed: variant not found (404). Exception opened.", daysAgo(0.2));
  const swapped = subs.find((s) => s.spec.customer === 16 && s.programId === progCacao.id)!;
  await A("SUBSCRIPTION_SWAPPED", "SUBSCRIPTION", swapped.id, "Arjun Mehta swapped Morning Magic → Ceremonial Cacao. Morning Magic journey ended at 2 deliveries; Cacao journey started at 0.", daysAgo(swapped.cycles * 30 + 2));
  await A("CYCLE_COMPLETED", "JOURNEY", swapped.journeyId!, "Arjun Mehta · Ceremonial Cacao: delivery 1 processed", daysAgo(3));
  const james = subs.find((s) => s.spec.customer === 1)!;
  await A("CYCLE_COMPLETED", "JOURNEY", james.journeyId!, "James Whitfield · Ceremonial Cacao: delivery 2 processed", daysAgo(3));
  await A("MARKER_QUEUED", "ACTION", james.id, "Planned 'Cacao Cycle 3' for James Whitfield · Ceremonial Cacao, delivery 3 on " + james.nextDate, daysAgo(3));
  await A("SUBSCRIPTION_CANCELLED", "SUBSCRIPTION", subs.find((s) => s.spec.status === "CANCELLED")!.id, "Chloe Davenport cancelled Himalayan Shilajit. No pending markers to remove.", daysAgo(2));

  return org;
}

async function seedSecondOrg(ownerId: string) {
  const org = await prisma.organization.create({
    data: { name: "Northwind Botanicals", slug: SECOND_ORG_SLUG, timezone: "America/New_York", currency: "USD" },
  });
  const O = { organizationId: org.id };
  await prisma.organizationMembership.create({ data: { ...O, userId: ownerId, role: "ADMIN" } });
  const integration = await prisma.integration.create({
    data: { ...O, provider: "RECHARGE", externalStoreId: "northwind-botanicals.myshopify.com", displayName: "Northwind (Recharge)", encryptedCredentials: "v1.seed.AAAA.AAAA.AAAA", automationMode: "OFF", lastSuccessfulSyncAt: daysAgo(1) },
  });
  const I = { ...O, integrationId: integration.id };
  const p = await prisma.product.create({ data: { ...I, externalProductId: nextId(), title: "Protein Blend", lastSyncedAt: now } });
  const v = await prisma.productVariant.create({ data: { ...O, productId: p.id, externalVariantId: nextId(), title: "Vanilla 1kg", sku: "NW-PRO-VAN", price: "49.00" } });
  const program = await prisma.subscriptionProgram.create({ data: { ...O, name: "Protein Subscription" } });
  await prisma.subscriptionProgramProduct.create({ data: { ...O, programId: program.id, productId: p.id } });
  const c = await prisma.customer.create({ data: { ...I, externalCustomerId: nextId(), firstName: "Maya", lastName: "Carter", email: "maya.carter@example.com" } });
  const nextDate = dateOnly(daysAhead(9));
  const sub = await prisma.subscription.create({
    data: {
      ...I,
      customerId: c.id,
      externalSubscriptionId: nextId(),
      externalCustomerId: c.externalCustomerId,
      externalAddressId: "addr-nw-1",
      status: "ACTIVE",
      mappingStatus: "MAPPED",
      productId: p.id,
      variantId: v.id,
      externalProductId: p.externalProductId,
      externalVariantId: v.externalVariantId,
      productTitleSnapshot: p.title,
      variantTitleSnapshot: v.title,
      skuSnapshot: v.sku,
      price: "49.00",
      intervalUnit: "day",
      intervalFrequency: 30,
      nextChargeDate: nextDate,
      nextChargeAt: new Date(nextDate + "T04:00:00Z"),
      lastSyncedAt: now,
    },
  });
  const j = await prisma.subscriptionJourney.create({
    data: { ...O, subscriptionId: sub.id, programId: program.id, productId: p.id, variantId: v.id, externalProductId: p.externalProductId, externalVariantId: v.externalVariantId, sequence: 1, startedAt: daysAgo(51), successfulCycles: 2 },
  });
  await prisma.subscription.update({ where: { id: sub.id }, data: { latestJourneyId: j.id } });
  await prisma.journeyCycle.createMany({
    data: [1, 2].map((n) => ({ ...O, journeyId: j.id, cycleNumber: n, externalOrderId: nextId(), orderKind: n === 1 ? "CHECKOUT" : "RECURRING", processedAt: daysAgo(51 - (n - 1) * 30), source: "BACKFILL" })),
  });
  await prisma.activityLog.create({ data: { ...O, actorType: "USER", actorId: ownerId, eventType: "ORGANIZATION_CREATED", entityType: "ORGANIZATION", entityId: org.id, summary: 'Organisation "Northwind Botanicals" created', createdAt: daysAgo(52) } });
  return org;
}

async function main() {
  console.log("Resetting demo data…");
  await resetDemo();
  console.log("Creating users…");
  const owner = await createUser(DEMO_EMAIL, "Otis Demo", "demo-password-123");
  const viewer = await createUser(VIEWER_EMAIL, "Viewer Demo", "viewer-password-123");
  console.log("Seeding Ancient Extracts Demo…");
  await seedDemoOrg(owner.id, viewer.id);
  console.log("Seeding Northwind Botanicals…");
  await seedSecondOrg(owner.id);
  console.log("\nDone.\n  Sign in:  demo@subscription-ops.local / demo-password-123\n  Viewer:   viewer@subscription-ops.local / viewer-password-123\n");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

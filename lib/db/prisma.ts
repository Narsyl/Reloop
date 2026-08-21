/**
 * Raw Prisma client singleton.
 *
 * IMPORTANT: tenant-owned data must be accessed through `dbFor(ctx)` from
 * `@/lib/db/tenant`, which injects `organizationId` into every query. The raw
 * client is only for: auth, webhook/job entry points that resolve an org first,
 * seeding, and tests. A lint rule restricts imports of this module.
 */
import { PrismaClient } from "@prisma/client";

function createPrismaClient() {
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    // Secrets never leave the database unless explicitly selected.
    // (Account.password must stay readable for Better Auth's credential sign-in.)
    omit: {
      integration: { encryptedCredentials: true },
    },
  });
}

export type AppPrismaClient = ReturnType<typeof createPrismaClient>;

const globalForPrisma = globalThis as unknown as { prisma?: AppPrismaClient };

export const prisma: AppPrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

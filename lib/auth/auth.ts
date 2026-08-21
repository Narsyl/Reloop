import "server-only";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { prisma } from "@/lib/db/prisma";

/**
 * Better Auth server instance.
 *
 * - email + password, sessions persisted in Postgres (Session table)
 * - Organization / membership are OUR tables (see prisma/schema.prisma); the
 *   active organisation is stored on Session.activeOrganizationId and managed
 *   by lib/auth/tenancy.ts — we deliberately do not use the auth library's
 *   organization plugin so tenancy rules live in our domain code.
 */
export const auth = betterAuth({
  appName: "Subscription Ops",
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    autoSignIn: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 14, // 14 days
    updateAge: 60 * 60 * 24, // refresh at most once a day
  },
  advanced: {
    database: { generateId: false }, // let Prisma cuid() generate ids
  },
  plugins: [nextCookies()],
});

export type Auth = typeof auth;

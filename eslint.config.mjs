import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const RAW_PRISMA_MESSAGE =
  "Tenant data must go through dbFor(ctx) from '@/lib/db/tenant'. The raw Prisma client is only allowed in lib/auth, lib/db, lib/jobs, prisma/ and tests/.";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // Tenant-isolation guard: UI, domain and connector code may not import the raw client.
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "lib/domain/**/*.{ts,tsx}", "lib/integrations/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "@/lib/db/prisma", message: RAW_PRISMA_MESSAGE }],
          patterns: [{ group: ["**/lib/db/prisma"], message: RAW_PRISMA_MESSAGE }],
        },
      ],
    },
  },
  // Explicit, reviewed exceptions (each resolves the organisation itself before querying).
  {
    files: ["lib/domain/organizations/actions.ts", "lib/domain/queries/settings.ts", "app/api/webhooks/**/*.ts"],
    rules: { "no-restricted-imports": "off" },
  },
]);

export default eslintConfig;

import { config } from "dotenv";
import path from "node:path";

// Load .env.local (gitignored) so DB-backed tests can reach Neon.
config({ path: path.resolve(__dirname, "..", ".env.local") });

// Deterministic encryption key for unit tests when none is configured.
if (!process.env.CREDENTIAL_ENCRYPTION_KEYS) {
  process.env.CREDENTIAL_ENCRYPTION_KEYS =
    "test:" + Buffer.alloc(32, 7).toString("base64");
}

/**
 * Minimal structured logger. One JSON line per event so Vercel/any log drain can
 * index by organizationId / integrationId / subscriptionId / actionId / eventId.
 *
 * Redaction: any field whose key looks secret-ish, or whose string value looks
 * like a token, is replaced before output. Never pass raw credentials in; this
 * is a safety net, not a licence.
 */
export type LogFields = Record<string, unknown>;

const SECRET_KEY = /token|secret|password|authorization|api[-_]?key|cookie|credential/i;
const TOKEN_LIKE = /^(sk_|rk_|whsec_|sha256_)?[A-Za-z0-9_\-]{32,}$/;

export function redactFields(fields: LogFields, depth = 0): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_KEY.test(k)) {
      out[k] = "[redacted]";
    } else if (typeof v === "string" && TOKEN_LIKE.test(v) && v.length >= 32) {
      out[k] = `[redacted:${v.length}]`;
    } else if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Error) && depth < 4) {
      out[k] = redactFields(v as LogFields, depth + 1);
    } else if (v instanceof Error) {
      out[k] = { name: v.name, message: v.message };
    } else {
      out[k] = v;
    }
  }
  return out;
}

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, msg: string, fields: LogFields) {
  if (level === "debug" && process.env.LOG_LEVEL !== "debug") return;
  const line = JSON.stringify({ level, msg, time: new Date().toISOString(), ...redactFields(fields) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, fields: LogFields = {}) => emit("debug", msg, fields),
  info: (msg: string, fields: LogFields = {}) => emit("info", msg, fields),
  warn: (msg: string, fields: LogFields = {}) => emit("warn", msg, fields),
  error: (msg: string, fields: LogFields = {}) => emit("error", msg, fields),
  /** Returns a logger that merges `base` into every line (e.g. org/integration ids). */
  child(base: LogFields) {
    return {
      debug: (msg: string, fields: LogFields = {}) => emit("debug", msg, { ...base, ...fields }),
      info: (msg: string, fields: LogFields = {}) => emit("info", msg, { ...base, ...fields }),
      warn: (msg: string, fields: LogFields = {}) => emit("warn", msg, { ...base, ...fields }),
      error: (msg: string, fields: LogFields = {}) => emit("error", msg, { ...base, ...fields }),
    };
  },
};

export type Logger = ReturnType<typeof logger.child>;

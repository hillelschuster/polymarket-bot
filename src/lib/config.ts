import { z } from "zod";

// Central env validation. Fails fast with a clear message if misconfigured.
const schema = z.object({
  NODE_ENV: z.string().default("development"),
  DATABASE_URL: z.string().default("file:./dev.db"),
  // Safety: this build is paper-trading only. Real execution is forbidden.
  EXECUTE_REAL_TRADES: z.string().default("false"),
  POLYMARKET_API_KEY: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  HERMES_API_KEY: z.string().optional(),
});

export const config = schema.parse(process.env);

// Hard safety invariant: never allow real trades in this build.
if (config.EXECUTE_REAL_TRADES === "true") {
  throw new Error("EXECUTE_REAL_TRADES must be false. This build is paper-trading only.");
}

// Live = hit Polymarket public APIs. Default true. Set USE_LIVE_DATA=false to run on seed/DEMO data only.
export const isLive: boolean = process.env.USE_LIVE_DATA ? process.env.USE_LIVE_DATA !== "false" : true;

const SECRET_KEYS = /KEY|TOKEN|SECRET|CHAT/;

// Redact secrets in an object for logging/UI by masking values whose key contains KEY/TOKEN/SECRET/CHAT.
export function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SECRET_KEYS.test(k) && typeof v === "string" ? v.slice(0, 4) + "…" + v.slice(-2) : v;
  }
  return out;
}

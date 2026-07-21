import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  DATABASE_URL: z.string().default("file:./dev.db"),
  USE_LIVE_DATA: z.enum(["true", "false"]).default("true"),

  EXECUTE_REAL_TRADES: z.enum(["true", "false"]).default("false"),
  LIVE_TRADING_PAUSED: z.enum(["true", "false"]).default("false"),
  POLYMARKET_PRIVATE_KEY: z.string().optional(),
  POLYMARKET_FUNDER_ADDRESS: z.string().optional(),
  POLYMARKET_SIGNATURE_TYPE: z.coerce.number().int().min(0).max(3).default(0),
  POLYMARKET_BUILDER_CODE: z.string().optional(),
  POLYGON_RPC_URL: z.string().optional(),
  CLOB_API_KEY: z.string().optional(),
  CLOB_API_SECRET: z.string().optional(),
  CLOB_API_PASSPHRASE: z.string().optional(),

  LIVE_CALENDAR_BASKET_USD: z.coerce.number().positive().max(10_000).default(10),
  LIVE_CALENDAR_MAX_COMBINED_COST: z.coerce.number().positive().lt(1).default(0.975),
  LIVE_CALENDAR_MAX_LEG_SPREAD: z.coerce.number().positive().max(0.1).default(0.02),
  LIVE_CALENDAR_MIN_PROFIT_USD: z.coerce.number().nonnegative().default(0.10),
  LIVE_BOOK_MAX_AGE_MS: z.coerce.number().int().positive().default(2_000),
  LIVE_BOOK_MAX_SKEW_MS: z.coerce.number().int().positive().default(1_000),
  LIVE_MAX_TOTAL_EXPOSURE_USD: z.coerce.number().positive().default(100),
  LIVE_MAX_OPEN_BASKETS: z.coerce.number().int().positive().default(5),
  LIVE_MAX_DAILY_UNWIND_LOSS_USD: z.coerce.number().positive().default(10),

  POLYMARKET_API_KEY: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  HERMES_API_KEY: z.string().optional(),
});

export const config = envSchema.parse(process.env);
export const isLive = config.USE_LIVE_DATA === "true";
export const realTradingEnabled =
  config.EXECUTE_REAL_TRADES === "true" && config.LIVE_TRADING_PAUSED !== "true";

export function assertLiveTradingConfigured(): void {
  if (!realTradingEnabled) throw new Error("Live trading is disabled");

  const required: Array<[string, string | undefined]> = [
    ["POLYMARKET_PRIVATE_KEY", config.POLYMARKET_PRIVATE_KEY],
    ["CLOB_API_KEY", config.CLOB_API_KEY],
    ["CLOB_API_SECRET", config.CLOB_API_SECRET],
    ["CLOB_API_PASSPHRASE", config.CLOB_API_PASSPHRASE],
  ];
  if (config.POLYMARKET_SIGNATURE_TYPE !== 0) {
    required.push(["POLYMARKET_FUNDER_ADDRESS", config.POLYMARKET_FUNDER_ADDRESS]);
  }
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`Missing live trading configuration: ${missing.join(", ")}`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(config.POLYMARKET_PRIVATE_KEY!)) {
    throw new Error("POLYMARKET_PRIVATE_KEY must be a 32-byte 0x-prefixed key");
  }
  if (config.POLYMARKET_FUNDER_ADDRESS && !/^0x[0-9a-fA-F]{40}$/.test(config.POLYMARKET_FUNDER_ADDRESS)) {
    throw new Error("POLYMARKET_FUNDER_ADDRESS must be a 20-byte 0x-prefixed address");
  }
}

const SECRET_KEYS = /KEY|TOKEN|SECRET|PASSPHRASE|PRIVATE|CHAT/i;
export function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = SECRET_KEYS.test(key) && typeof value === "string"
      ? `${value.slice(0, 4)}…${value.slice(-2)}`
      : value;
  }
  return out;
}

import { randomUUID } from "node:crypto";
import { prisma } from "./db.js";

const TABLE = "live_calendar_baskets";

export interface NewLiveBasket {
  attemptKey: string;
  pairKey: string;
  earlyMarketId: string;
  lateMarketId: string;
  earlyConditionId: string;
  lateConditionId: string;
  earlySlug: string;
  lateSlug: string;
  earlyTokenId: string;
  lateTokenId: string;
  shares: number;
  earlyCashCost: number;
  lateCashCost: number;
  quotedCombinedCost: number;
  quotedCashCost: number;
  quotedProfit: number;
  status: string;
  submittedAt?: number;
}

export interface StoredLiveBasket {
  id: string;
  attemptKey: string;
  pairKey: string;
  earlyMarketId: string;
  lateMarketId: string;
  earlyConditionId: string;
  lateConditionId: string;
  earlySlug: string;
  lateSlug: string;
  earlyTokenId: string;
  lateTokenId: string;
  shares: number;
  earlyCashCost: number;
  lateCashCost: number;
  quotedCombinedCost: number;
  quotedCashCost: number;
  quotedProfit: number;
  status: string;
  earlyOrderId: string | null;
  lateOrderId: string | null;
  earlyResponseJson: string | null;
  lateResponseJson: string | null;
  unwindOrderId: string | null;
  unwindResponseJson: string | null;
  unwindPnl: number | null;
  earlyResolvedAt: number | null;
  lateResolvedAt: number | null;
  earlyPayout: number | null;
  latePayout: number | null;
  realizedPnl: number | null;
  error: string | null;
  detectedAt: number;
  submittedAt: number | null;
  filledAt: number | null;
  closedAt: number | null;
  updatedAt: number;
}

const columns: Record<string, string> = {
  status: "status",
  earlyOrderId: "early_order_id",
  lateOrderId: "late_order_id",
  earlyResponseJson: "early_response_json",
  lateResponseJson: "late_response_json",
  unwindOrderId: "unwind_order_id",
  unwindResponseJson: "unwind_response_json",
  unwindPnl: "unwind_pnl",
  earlyResolvedAt: "early_resolved_at",
  lateResolvedAt: "late_resolved_at",
  earlyPayout: "early_payout",
  latePayout: "late_payout",
  realizedPnl: "realized_pnl",
  error: "error",
  submittedAt: "submitted_at",
  filledAt: "filled_at",
  closedAt: "closed_at",
};

export async function initLiveCalendarStore(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      attempt_key TEXT NOT NULL UNIQUE,
      pair_key TEXT NOT NULL,
      early_market_id TEXT NOT NULL,
      late_market_id TEXT NOT NULL,
      early_condition_id TEXT NOT NULL,
      late_condition_id TEXT NOT NULL,
      early_slug TEXT NOT NULL,
      late_slug TEXT NOT NULL,
      early_token_id TEXT NOT NULL,
      late_token_id TEXT NOT NULL,
      shares REAL NOT NULL,
      early_cash_cost REAL NOT NULL,
      late_cash_cost REAL NOT NULL,
      quoted_combined_cost REAL NOT NULL,
      quoted_cash_cost REAL NOT NULL,
      quoted_profit REAL NOT NULL,
      status TEXT NOT NULL,
      early_order_id TEXT,
      late_order_id TEXT,
      early_response_json TEXT,
      late_response_json TEXT,
      unwind_order_id TEXT,
      unwind_response_json TEXT,
      unwind_pnl REAL,
      early_resolved_at INTEGER,
      late_resolved_at INTEGER,
      early_payout REAL,
      late_payout REAL,
      realized_pnl REAL,
      error TEXT,
      detected_at INTEGER NOT NULL,
      submitted_at INTEGER,
      filled_at INTEGER,
      closed_at INTEGER,
      updated_at INTEGER NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_live_calendar_pair_status ON ${TABLE}(pair_key, status)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_live_calendar_status_time ON ${TABLE}(status, detected_at)`);
}

function mapRow(raw: Record<string, unknown>): StoredLiveBasket {
  return {
    id: String(raw.id),
    attemptKey: String(raw.attempt_key),
    pairKey: String(raw.pair_key),
    earlyMarketId: String(raw.early_market_id),
    lateMarketId: String(raw.late_market_id),
    earlyConditionId: String(raw.early_condition_id),
    lateConditionId: String(raw.late_condition_id),
    earlySlug: String(raw.early_slug),
    lateSlug: String(raw.late_slug),
    earlyTokenId: String(raw.early_token_id),
    lateTokenId: String(raw.late_token_id),
    shares: Number(raw.shares),
    earlyCashCost: Number(raw.early_cash_cost),
    lateCashCost: Number(raw.late_cash_cost),
    quotedCombinedCost: Number(raw.quoted_combined_cost),
    quotedCashCost: Number(raw.quoted_cash_cost),
    quotedProfit: Number(raw.quoted_profit),
    status: String(raw.status),
    earlyOrderId: raw.early_order_id == null ? null : String(raw.early_order_id),
    lateOrderId: raw.late_order_id == null ? null : String(raw.late_order_id),
    earlyResponseJson: raw.early_response_json == null ? null : String(raw.early_response_json),
    lateResponseJson: raw.late_response_json == null ? null : String(raw.late_response_json),
    unwindOrderId: raw.unwind_order_id == null ? null : String(raw.unwind_order_id),
    unwindResponseJson: raw.unwind_response_json == null ? null : String(raw.unwind_response_json),
    unwindPnl: raw.unwind_pnl == null ? null : Number(raw.unwind_pnl),
    earlyResolvedAt: raw.early_resolved_at == null ? null : Number(raw.early_resolved_at),
    lateResolvedAt: raw.late_resolved_at == null ? null : Number(raw.late_resolved_at),
    earlyPayout: raw.early_payout == null ? null : Number(raw.early_payout),
    latePayout: raw.late_payout == null ? null : Number(raw.late_payout),
    realizedPnl: raw.realized_pnl == null ? null : Number(raw.realized_pnl),
    error: raw.error == null ? null : String(raw.error),
    detectedAt: Number(raw.detected_at),
    submittedAt: raw.submitted_at == null ? null : Number(raw.submitted_at),
    filledAt: raw.filled_at == null ? null : Number(raw.filled_at),
    closedAt: raw.closed_at == null ? null : Number(raw.closed_at),
    updatedAt: Number(raw.updated_at),
  };
}

export async function createLiveBasket(input: NewLiveBasket): Promise<{ id: string } | null> {
  const id = randomUUID();
  const now = Date.now();
  const changed = await prisma.$executeRawUnsafe(
    `INSERT OR IGNORE INTO ${TABLE} (
      id, attempt_key, pair_key,
      early_market_id, late_market_id, early_condition_id, late_condition_id,
      early_slug, late_slug, early_token_id, late_token_id,
      shares, early_cash_cost, late_cash_cost,
      quoted_combined_cost, quoted_cash_cost, quoted_profit,
      status, detected_at, submitted_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, input.attemptKey, input.pairKey,
    input.earlyMarketId, input.lateMarketId, input.earlyConditionId, input.lateConditionId,
    input.earlySlug, input.lateSlug, input.earlyTokenId, input.lateTokenId,
    input.shares, input.earlyCashCost, input.lateCashCost,
    input.quotedCombinedCost, input.quotedCashCost, input.quotedProfit,
    input.status, now, input.submittedAt ?? null, now,
  );
  return changed > 0 ? { id } : null;
}

export async function updateLiveBasket(
  id: string,
  patch: Partial<Pick<StoredLiveBasket,
    "status" | "earlyOrderId" | "lateOrderId" | "earlyResponseJson" | "lateResponseJson" |
    "unwindOrderId" | "unwindResponseJson" | "unwindPnl" | "earlyResolvedAt" | "lateResolvedAt" |
    "earlyPayout" | "latePayout" | "realizedPnl" | "error" | "submittedAt" | "filledAt" | "closedAt"
  >>,
): Promise<void> {
  const entries = Object.entries(patch).filter(([key]) => key in columns);
  if (!entries.length) return;
  const setters = entries.map(([key]) => `${columns[key]} = ?`);
  const values = entries.map(([, value]) => value ?? null);
  setters.push("updated_at = ?");
  values.push(Date.now(), id);
  await prisma.$executeRawUnsafe(`UPDATE ${TABLE} SET ${setters.join(", ")} WHERE id = ?`, ...values);
}

async function rows(query: string, ...values: unknown[]): Promise<StoredLiveBasket[]> {
  const raw = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(query, ...values);
  return raw.map(mapRow);
}

export async function getLiveBasket(id: string): Promise<StoredLiveBasket | null> {
  return (await rows(`SELECT * FROM ${TABLE} WHERE id = ? LIMIT 1`, id))[0] ?? null;
}

export async function listPendingLiveBaskets(): Promise<StoredLiveBasket[]> {
  return rows(`SELECT * FROM ${TABLE} WHERE status IN ('submitting','matched_pending') ORDER BY submitted_at ASC`);
}

export async function listFilledLiveBaskets(): Promise<StoredLiveBasket[]> {
  return rows(`SELECT * FROM ${TABLE} WHERE status = 'filled' ORDER BY filled_at ASC`);
}

export async function activePairExists(pairKey: string): Promise<boolean> {
  const result = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
    `SELECT COUNT(*) AS n FROM ${TABLE} WHERE pair_key = ? AND status IN ('submitting','matched_pending','filled','unwinding','unwind_failed','manual_review')`,
    pairKey,
  );
  return Number(result[0]?.n ?? 0) > 0;
}

export async function getExecutionRisk(): Promise<{ openCount: number; exposure: number; incidents: number }> {
  const open = await prisma.$queryRawUnsafe<Array<{ n: bigint | number; exposure: number | null }>>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(quoted_cash_cost), 0) AS exposure FROM ${TABLE} WHERE status IN ('submitting','matched_pending','filled','unwinding')`,
  );
  const incidents = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
    `SELECT COUNT(*) AS n FROM ${TABLE} WHERE status IN ('unwind_failed','manual_review')`,
  );
  return {
    openCount: Number(open[0]?.n ?? 0),
    exposure: Number(open[0]?.exposure ?? 0),
    incidents: Number(incidents[0]?.n ?? 0),
  };
}

export async function dailyUnwindLoss(startMs: number): Promise<number> {
  const result = await prisma.$queryRawUnsafe<Array<{ loss: number | null }>>(
    `SELECT COALESCE(-SUM(unwind_pnl), 0) AS loss FROM ${TABLE} WHERE detected_at >= ? AND unwind_pnl < 0`,
    startMs,
  );
  return Number(result[0]?.loss ?? 0);
}

export async function resolveLiveMarket(conditionId: string, payouts: Record<string, number>, resolvedAt = Date.now()): Promise<void> {
  const affected = await rows(
    `SELECT * FROM ${TABLE} WHERE status = 'filled' AND (early_condition_id = ? OR late_condition_id = ?)`,
    conditionId,
    conditionId,
  );
  for (const row of affected) {
    if (row.earlyConditionId === conditionId && row.earlyResolvedAt == null) {
      await updateLiveBasket(row.id, {
        earlyResolvedAt: resolvedAt,
        earlyPayout: row.shares * (payouts[row.earlyTokenId] ?? 0),
      });
    }
    if (row.lateConditionId === conditionId && row.lateResolvedAt == null) {
      await updateLiveBasket(row.id, {
        lateResolvedAt: resolvedAt,
        latePayout: row.shares * (payouts[row.lateTokenId] ?? 0),
      });
    }
    const fresh = await getLiveBasket(row.id);
    if (fresh?.earlyResolvedAt != null && fresh.lateResolvedAt != null) {
      const realizedPnl = (fresh.earlyPayout ?? 0) + (fresh.latePayout ?? 0) - fresh.quotedCashCost;
      await updateLiveBasket(row.id, { status: "resolved", realizedPnl, closedAt: resolvedAt });
    }
  }
}

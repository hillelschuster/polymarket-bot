// djReplay.ts -- Decision Journal replay & mechanism validation
// Run: npx tsx analysis/djReplay.ts
// Uses sqlite3 CLI for DB reads, Gamma + Data API for market data.

import { execSync } from "node:child_process";
import {
  favoriteAtEntry,
  simulateTakerBuy,
  takerFeePerShare,
  type HistoricalTrade,
} from "./sportsBacktest.js";

const DATA_API = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";
const DB = "/var/lib/trading-bots/polymarket-bot/polymarket-bot.sqlite";

function sqlScalar(query: string): string {
  return execSync("sqlite3 " + DB + " " + JSON.stringify(query), { timeout: 10000, encoding: "utf8" }).trim();
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "content-type": "application/json" } });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + url);
  return res.json() as Promise<T>;
}

function parseJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") try { const p = JSON.parse(raw); return Array.isArray(p) ? p.map(String) : []; } catch { return []; }
  return [];
}
function parseNumArray(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map(Number);
  if (typeof raw === "string") try { const p = JSON.parse(raw); return Array.isArray(p) ? p.map(Number) : []; } catch { return []; }
  return [];
}

async function getMarketData(identifier: string): Promise<{ conditionId: string | null; tokenIds: string[]; winnerIndex: number | null; outcomePrices: number[] }> {
  try {
    // If it looks like a condition ID (0x hex), use query param; otherwise use direct endpoint
    let raw: any;
    if (identifier.startsWith("0x") && identifier.length > 30) {
      const qs = new URLSearchParams({ closed: "true", conditionId: identifier, limit: "1" });
      const arr = await fetchJson<any[]>(GAMMA_API + "/markets?" + qs);
      raw = Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
    } else {
      raw = await fetchJson<any>(GAMMA_API + "/markets/" + identifier);
    }
    if (!raw || !raw.id) return { conditionId: null, tokenIds: [], winnerIndex: null, outcomePrices: [] };
    const tokenIds = parseJsonArray(raw.clobTokenIds);
    const prices = parseNumArray(raw.outcomePrices);
    let winnerIndex: number | null = null;
    if (prices.length === 2 && prices.every((p) => Number.isFinite(p) && (p <= 0.005 || p >= 0.995))) {
      const winners = prices.map((p, i) => ({ p, i })).filter((x) => x.p >= 0.995);
      if (winners.length === 1) winnerIndex = winners[0].i;
    }
    return { conditionId: String(raw.conditionId ?? ""), tokenIds, winnerIndex, outcomePrices: prices };
  } catch {
    return { conditionId: null, tokenIds: [], winnerIndex: null, outcomePrices: [] };
  }
}

async function fetchTakerTrades(conditionId: string, start: number, end: number): Promise<HistoricalTrade[]> {
  const qs = new URLSearchParams({ market: conditionId, limit: "10000", takerOnly: "true" });
  const raw = await fetchJson<any[]>(DATA_API + "/trades?" + qs);
  if (!Array.isArray(raw)) return [];
  const trades: HistoricalTrade[] = [];
  for (const t of raw) {
    const asset = String(t.asset ?? ""); const side = String(t.side ?? "");
    const size = Number(t.size); const price = Number(t.price); const ts = Number(t.timestamp);
    if (!asset || !side || !(size > 0) || !(price > 0 && price < 1) || !Number.isFinite(ts)) continue;
    if (ts < start || ts > end) continue;
    trades.push({ asset, side, size, price, timestamp: ts });
  }
  return trades.sort((a, b) => a.timestamp - b.timestamp);
}

// ─── PART 1: Mechanism validation ───
async function part1(): Promise<void> {
  console.log("\n=== PART 1: Mechanism Validation ===\n");
  const out = execSync("sqlite3 " + DB + " \"SELECT marketId, entryPrice, simulatedPositionSize, openedAt FROM PaperTrade WHERE status='resolved' AND source='strategy' ORDER BY openedAt;\"", { timeout: 15000, encoding: "utf8" });
  const rawRows: { marketId: string; entryPrice: number; budget: number; openedAtMs: number }[] = [];
  for (const line of out.trim().split("\n").filter(Boolean)) {
    const parts = line.split("|");
    if (parts.length < 4) continue;
    rawRows.push({ marketId: parts[0], entryPrice: Number(parts[1]), budget: Number(parts[2]), openedAtMs: Number(parts[3]) });
  }
  console.log("Found " + rawRows.length + " resolved strategy trades\n");

  const results: { marketId: string; entryPrice: number; simAllInPrice: number | null; pctDiff: number | null; reason: string }[] = [];

  for (let i = 0; i < rawRows.length; i++) {
    const { marketId, entryPrice, budget, openedAtMs } = rawRows[i];
    const entryTs = Math.floor(openedAtMs / 1000);

    const md = await getMarketData(marketId);
    if (!md.conditionId) { results.push({ marketId, entryPrice, simAllInPrice: null, pctDiff: null, reason: "no_condition_id" }); continue; }
    if (md.tokenIds.length !== 2) { results.push({ marketId, entryPrice, simAllInPrice: null, pctDiff: null, reason: "bad_tokens" }); continue; }

    const lookbackStart = entryTs - 30 * 60;
    const fillEnd = entryTs + 300;
    const trades = await fetchTakerTrades(md.conditionId, lookbackStart, fillEnd);
    if (trades.length === 0) { results.push({ marketId, entryPrice, simAllInPrice: null, pctDiff: null, reason: "no_trades" }); continue; }

    const favorite = favoriteAtEntry(trades, md.tokenIds, entryTs, 30 * 60);
    if (!favorite) { results.push({ marketId, entryPrice, simAllInPrice: null, pctDiff: null, reason: "no_fav_price" }); continue; }

    const feeRate = 0.10;
    const tickSize = 0.01;
    const fill = simulateTakerBuy(trades, favorite.tokenId, entryTs, 300, budget, feeRate, tickSize);
    if (fill) {
      const pctDiff = (fill.allInPrice - entryPrice) / entryPrice;
      results.push({ marketId, entryPrice, simAllInPrice: fill.allInPrice, pctDiff, reason: "taker_print" });
    } else {
      const sp = Math.min(0.9999, favorite.referencePrice + tickSize);
      const fps = takerFeePerShare(sp, feeRate);
      const aip = sp + fps;
      const pctDiff = entryPrice > 0 ? (aip - entryPrice) / entryPrice : null;
      results.push({ marketId, entryPrice, simAllInPrice: aip, pctDiff, reason: "synthetic" });
    }

    if ((i + 1) % 6 === 0 || i === rawRows.length - 1) console.log("  Part 1 progress: " + (i + 1) + "/" + rawRows.length);
  }

  const valid = results.filter((r) => r.pctDiff != null);
  const noData = results.filter((r) => r.pctDiff == null);
  const meanDiff = valid.length > 0 ? valid.reduce((s, r) => s + r.pctDiff!, 0) / valid.length : 0;
  const within2 = valid.filter((r) => Math.abs(r.pctDiff!) <= 0.02);
  const within5 = valid.filter((r) => Math.abs(r.pctDiff!) <= 0.05);

  console.log("\nPart 1 Results:");
  console.log("  Total: " + results.length);
  console.log("  Simulated: " + valid.length + " (taker_print: " + valid.filter(r => r.reason === "taker_print").length + ", synthetic: " + valid.filter(r => r.reason === "synthetic").length + ")");
  console.log("  No data: " + noData.length + " [" + noData.map(r => r.reason).join(", ") + "]");
  console.log("  Mean % diff (sim - live) / live: " + (meanDiff * 100).toFixed(2) + "%");
  console.log("  Within 2%: " + (valid.length > 0 ? (within2.length / valid.length * 100).toFixed(1) : "N/A") + "% (" + within2.length + "/" + valid.length + ")");
  console.log("  Within 5%: " + (valid.length > 0 ? (within5.length / valid.length * 100).toFixed(1) : "N/A") + "% (" + within5.length + "/" + valid.length + ")");
}

// ─── PART 2: Executed reproduction ───
async function part2(): Promise<void> {
  console.log("\n=== PART 2: Executed Reproduction ===\n");
  const out = execSync("sqlite3 " + DB + " \"SELECT source, SUM(realizedPnl), COUNT(*) FROM PaperTrade WHERE status='resolved' GROUP BY source;\"", { timeout: 15000, encoding: "utf8" });
  console.log("Resolved PaperTrade PnL by source:");
  for (const line of out.trim().split("\n").filter(Boolean)) {
    const parts = line.split("|");
    if (parts.length < 3) continue;
    const sum = Number(parts[1]);
    const sign = sum >= 0 ? "+" : "";
    console.log("  " + parts[0] + ": " + sign + "$" + sum.toFixed(2) + " (" + parts[2] + " trades)");
  }

  const strat = sqlScalar("SELECT SUM(realizedPnl) FROM \"PaperTrade\" WHERE status='resolved' AND source='strategy'");
  const wallet = sqlScalar("SELECT SUM(realizedPnl) FROM \"PaperTrade\" WHERE status='resolved' AND source='wallet_copy'");
  console.log("\nExpected:  strategy +$50.08 / wallet_copy +$123.09");
  console.log("Got:       strategy " + (Number(strat) >= 0 ? "+" : "") + "$" + Number(strat).toFixed(2) + " / wallet_copy " + (Number(wallet) >= 0 ? "+" : "") + "$" + Number(wallet).toFixed(2));
  const matchStrat = Math.abs(Number(strat) - 50.08) < 0.01;
  const matchWallet = Math.abs(Number(wallet) - 123.09) < 0.01;
  console.log("Match:     strategy " + (matchStrat ? "YES" : "NO") + " / wallet_copy " + (matchWallet ? "YES" : "NO"));
}

// ─── PART 3: Skipped-signal counterfactual ───
async function part3(): Promise<void> {
  console.log("\n=== PART 3: Skipped-Signal Counterfactual ===\n");

  const out = execSync("sqlite3 " + DB + " \"SELECT marketId, firstFailingGate, executableAsk FROM DecisionJournal WHERE decision='skip' AND executableAsk IS NOT NULL;\"", { timeout: 30000, encoding: "utf8" });
  const lines = out.trim().split("\n").filter(Boolean);
  console.log("Total skip signals with executableAsk: " + lines.length + "\n");

  // Group by gate for display
  const byGate = new Map<string, { marketIds: Set<string>; asks: number[]; signals: number }>();
  for (const line of lines) {
    const parts = line.split("|");
    if (parts.length < 3) continue;
    const marketId = parts[0];
    const gate = parts[1] || "unknown";
    const ask = Number(parts[2]);
    if (!byGate.has(gate)) byGate.set(gate, { marketIds: new Set(), asks: [], signals: 0 });
    const g = byGate.get(gate)!;
    g.marketIds.add(marketId);
    g.asks.push(ask);
    g.signals++;
  }

  console.log("Gates:");
  for (const [gate, data] of byGate) {
    console.log("  " + gate + ": " + data.signals + " signals across " + data.marketIds.size + " markets");
  }

  // Fetch outcomes
  const allMarkets = new Set<string>();
  for (const [, data] of byGate) for (const mid of data.marketIds) allMarkets.add(mid);
  console.log("\nFetching " + allMarkets.size + " market outcomes from Gamma...");

  const outcomes = new Map<string, number | null>();
  let fetched = 0;
  for (const marketId of allMarkets) {
    const md = await getMarketData(marketId);
    outcomes.set(marketId, md.winnerIndex);
    fetched++;
    if (fetched % 5 === 0) console.log("  fetched " + fetched + "/" + allMarkets.size);
  }

  // Counterfactual per gate: buy outcome 0 (YES/favorite by convention) at executableAsk
  console.log("\nCounterfactual ($10/trade, 0.10 fee, bought outcome 0):");
  console.log("Gate".padEnd(32) + "Signals".padEnd(10) + "Markets".padEnd(10) + "Win%".padEnd(10) + "PnL/trade".padEnd(12) + "Total PnL");
  console.log("-".repeat(74));

  console.log("Outcomes with winner determinate: " + [...outcomes.values()].filter((v) => v != null).length + "/" + outcomes.size);

  const gatePnl = new Map<string, { wins: number; totalPnl: number; count: number; totalSignals: number; totalMarkets: number }>();
  for (const [gate, data] of byGate) {
    gatePnl.set(gate, { wins: 0, totalPnl: 0, count: 0, totalSignals: data.signals, totalMarkets: data.marketIds.size });
  }

  for (const line of lines) {
    const parts = line.split("|");
    if (parts.length < 3) continue;
    const marketId = parts[0];
    const gate = parts[1] || "unknown";
    const ask = Number(parts[2]);

    const winnerIdx = outcomes.get(marketId);
    if (winnerIdx == null) continue;

    const g = gatePnl.get(gate);
    if (!g) continue;
    g.count++;

    const execPrice = Math.min(0.9999, ask);
    const feePerShare = takerFeePerShare(execPrice, 0.10);
    const allInPrice = execPrice + feePerShare;
    const shares = 10 / allInPrice;
    const cashSpent = shares * allInPrice;
    const won = winnerIdx === 0;
    const pnl = (won ? shares : 0) - cashSpent;
    if (won) g.wins++;
    g.totalPnl += pnl;
  }

  const sorted = [...gatePnl.entries()].sort((a, b) => b[1].totalPnl - a[1].totalPnl);
  for (const [gate, data] of sorted) {
    const winPct = data.count > 0 ? (data.wins / data.count * 100).toFixed(1) + "%" : "N/A";
    const pnlPerTrade = data.count > 0 ? data.totalPnl / data.count : 0;
    console.log(
      gate.padEnd(32) +
      String(data.totalSignals).padEnd(10) +
      String(data.totalMarkets).padEnd(10) +
      winPct.padEnd(10) +
      "$" + pnlPerTrade.toFixed(2).padEnd(10) +
      "$" + data.totalPnl.toFixed(2) +
      " (with outcome: " + data.count + ")"
    );
  }
}

async function main() {
  console.log("=== DJ Replay Analysis ===");
  console.log("DB: " + DB);
  await part1();
  await part2();
  await part3();
}

main().catch((e) => { console.error(e); process.exit(1); });

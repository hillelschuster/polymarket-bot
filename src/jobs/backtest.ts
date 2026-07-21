// Offline validation of the market-variable equation on REAL resolved outcomes.
// No orders placed, no live waiting — replays every past decision and measures what
// the equation's score actually predicts. Walk-forward style (Turbine quant playbook):
// a signal is only an edge if higher scores → better real returns.
// Run: npm run backtest
import { prisma } from "../lib/db.js";
import { scoreTradeByMarket, DEFAULT_RULES, type RuleSetValues } from "../lib/scoring.js";
import { getMarketBySlug } from "../adapters/polymarket.js";

interface Row { score: number; pnl: number; win: boolean; }

// PnL of copying a wallet's historical trade at its fill price, held to resolution.
function pnlFor(side: string | null, entry: number, yesWon: boolean): number {
  const isBuy = (side ?? "BUY").toUpperCase() === "BUY";
  return isBuy ? (yesWon ? 1 : 0) - entry : entry - (yesWon ? 1 : 0);
}

function summarize(label: string, rows: Row[]): void {
  if (!rows.length) { console.log(`${label.padEnd(22)} n=   0`); return; }
  const n = rows.length;
  const wins = rows.filter((r) => r.win).length;
  const pnl = rows.reduce((a, r) => a + r.pnl, 0);
  const avg = pnl / n;
  console.log(`${label.padEnd(22)} n=${String(n).padStart(4)}  win=${String(Math.round((wins / n) * 100)).padStart(3)}%  pnl=$${pnl.toFixed(2).padStart(8)}  avg=$${avg.toFixed(3)}`);
}

async function main() {
  const rules: RuleSetValues = DEFAULT_RULES;
  const SIZE = 5; // hypothetical $5/position for comparability

  // Resolved markets we already snapshotted (yesPrice ~0 or ~1).
  // Also store spread, liquidity, endDate for realistic gate simulation.
  const snaps = await prisma.marketSnapshot.findMany({});
  interface SnapData { yes: number; no: number; spread: number | null; liquidity: number | null; timeToResolution: number | null; }
  const resolvedBySlug = new Map<string, SnapData>();
  for (const s of snaps) {
    if (s.slug && s.yesPrice != null && (s.yesPrice < 0.02 || s.yesPrice > 0.98)) {
      resolvedBySlug.set(s.slug, {
        yes: s.yesPrice,
        no: s.noPrice ?? 1 - s.yesPrice,
        spread: s.spread,
        liquidity: s.liquidity,
        timeToResolution: s.timeToResolution,
      });
    }
  }
  const fetchCache = new Map<string, SnapData>();
  async function finalFor(slug?: string | null): Promise<SnapData | null> {
    if (!slug) return null;
    if (resolvedBySlug.has(slug)) return resolvedBySlug.get(slug)!;
    if (fetchCache.has(slug)) return fetchCache.get(slug)!;
    try {
      const m = await getMarketBySlug(slug);
      if (!m) return null;
      const yes = m.outcomePrices[0];
      const no = m.outcomePrices[1] ?? 1 - yes;
      if (yes < 0.02 || yes > 0.98) {
        const r: SnapData = { yes, no,         spread: m.spread, liquidity: m.liquidity, timeToResolution: null as any };
        fetchCache.set(slug, r); return r;
      }
    } catch { /* ignore */ }
    return null;
  }

  const djs = await prisma.decisionJournal.findMany({ include: { observedTrade: true } });
  const rows: Row[] = [];
  let resolved = 0;
  for (const dj of djs) {
    const ot = dj.observedTrade;
    if (!ot || !ot.slug) continue;
    const fin = await finalFor(ot.slug);
    if (!fin) continue;
    const yesWon = fin.yes > 0.5;
    const entry = ot.walletEntryPrice ?? ot.detectedPrice ?? 0.5;
    if (entry <= 0 || entry >= 1) continue;
    const pnl = pnlFor(ot.side, entry, yesWon) * SIZE;
    const side = (ot.side ?? "BUY").toUpperCase();
    // Use real market data from the snapshot (spread, liquidity, days to resolution)
    // instead of hardcoded defaults, so gate-tuning works accurately.
    const daysToR = fin.timeToResolution ?? 30;
    const mkt = scoreTradeByMarket({
      side: ot.side ?? "BUY",
      currentPrice: side === "SELL" ? 1 - entry : entry,
      priceMovementSinceEntry: 0,
      spread: ot.marketSpread ?? fin.spread ?? 0.02,
      liquidity: ot.marketLiquidity ?? fin.liquidity ?? 5000,
      volume: 0,
      daysToResolution: daysToR,
    }, rules);
    rows.push({ score: mkt.skip ? -1 : mkt.score, pnl, win: pnl > 0 });
    resolved++;
  }

  console.log(`\n=== BACKTEST — ${resolved} resolved decisions ===\n`);
  // Quartile analysis by equation score (does higher score → better outcome?).
  const sorted = [...rows].sort((a, b) => b.score - a.score);
  const q = Math.ceil(sorted.length / 4);
  summarize("Q1 (top score)", sorted.slice(0, q));
  summarize("Q2", sorted.slice(q, 2 * q));
  summarize("Q3", sorted.slice(2 * q, 3 * q));
  summarize("Q4 (bottom)", sorted.slice(3 * q));
  summarize("ALL", sorted);

  // Threshold sweep: copy only trades with score >= T.
  console.log(`\n--- Threshold sweep (copy if score >= T) ---`);
  for (const T of [40, 50, 55, 60, 65, 70]) {
    const kept = rows.filter((r) => r.score >= T);
    summarize(`copy>=${T}`, kept);
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });

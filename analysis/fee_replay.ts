/**
 * Fee-only historical replay for the live authoritative DB. READ-ONLY.
 *
 * Scope: wallet_copy paper trades opened since the modern policy start.
 * Question: does the current live fee model (rate/exponent) change the
 * all-in entry cost — and therefore terminal PnL — vs. what was recorded?
 *
 * Method (no rows are written):
 *   1. Select PaperTrade: source="wallet_copy", openedAt >= MODERN_START,
 *      linked DecisionJournal.decision="paper_copy".
 *   2. For each unique token, fetch the live fee model via
 *      getFeeModel(tokenId, marketId) — PaperTrade.marketId IS the conditionId
 *      (0x hex), so this is the same call the production jobs make. The helper
 *      caches per tokenId for 5 min. Report rate/exponent distribution + failures.
 *   3. Fee-only corrected replay:
 *      - historical raw average ask is inferred, not looked up in depth:
 *          pRaw = (allInPrice * shares - fee) / shares
 *      - exponent == 1 or rateBps == 0 → preserve the recorded quote exactly
 *        (the recorded quote already used this same formula).
 *      - otherwise → recompute the fee at pRaw with the fetched model, hold the
 *        stake fixed, and recompute terminal PnL. This is an EFFECTIVE-AVERAGE
 *        fee-only replay for the non-1 case, NOT a reconstruction of raw
 *        historical order-book depth.
 *      - corrected terminal PnL = sharesCorrected * terminal - stake, where
 *        terminal = OutcomeReview.finalOutcome (settlement) when present, else
 *        the current mark (PaperTrade.currentPrice); sharesCorrected = stake /
 *        (pRaw + feePerShare(pRaw)); stake = simulatedPositionSize (the
 *        deployed capital the paper PnL is computed on).
 *   4. Aggregates (count, stake, current paper PnL, corrected PnL, delta, ROI):
 *        a. marketSegment (journal decision-time): sports_mainline / tennis / other / total
 *        b. walletQualityScore: <35 / >=35 / unknown / total
 *        c. decision-time executable entry (allInPrice, fallback entryPrice):
 *           <0.75 / >=0.75 / unknown / total
 *   5. Status counts + explicit omitted rows (no journal / no quote / no fee).
 *
 * Deterministic except the live fee metadata (rate/exponent per token).
 *
 * Run:
 *   DATABASE_URL="file:/mnt/c/home/hillel/polymarket-bot-dev.db?mode=ro&immutable=1" \
 *     npx tsx analysis/fee_replay.ts
 */
import { PrismaClient } from "@prisma/client";
import { getFeeModel } from "../src/adapters/marketFees.js";
import { takerFeePerShare } from "../src/lib/executableQuotes.js";
import type { FeeModel } from "../src/adapters/marketFees.js";

const prisma = new PrismaClient();

const MODERN_START = new Date("2026-08-02T15:11:51.657Z");
const FETCH_PACE_MS = 150; // polite spacing between CLOB fee-model calls

type Mode = "preserved" | "replayed";

interface ReplayRow {
  id: string;
  slug: string;
  status: string;
  segment: string;    // sports_mainline | tennis | other
  quality: string;    // <35 | >=35 | unknown
  entryBucket: string; // <0.75 | >=0.75 | unknown
  entry: number;
  stake: number;
  pnlPaper: number;
  pnlCorrected: number;
  delta: number;
  mode: Mode;
  rateBps: number;
  exponent: number;
}

function usd6(n: number): string {
  return `${n >= 0 ? "+" : ""}$${n.toFixed(6)}`;
}

function pct4(n: number, d: number): string {
  return d > 0 ? `${((100 * n) / d).toFixed(4)}%` : "n/a";
}

/** Bucket a raw journal segment into the three reported buckets. */
function segmentBucket(seg: string | null): string {
  if (seg === "sports_mainline" || seg === "tennis") return seg;
  return "other";
}

function qualityBucket(q: number | null): string {
  if (q == null) return "unknown";
  return q < 35 ? "<35" : ">=35";
}

function entryBucket(entry: number | null): string {
  if (entry == null) return "unknown";
  return entry < 0.75 ? "<0.75" : ">=0.75";
}

async function main(): Promise<void> {
  const rows = await prisma.paperTrade.findMany({
    where: { source: "wallet_copy", openedAt: { gte: MODERN_START } },
    include: { decisionJournal: { include: { outcomeReview: true } } },
    orderBy: [{ openedAt: "asc" }, { id: "asc" }],
  });

  // --- Classify: eligible for replay vs omitted (no journal / no quote / no fee) ---
  const omittedNoJournal: string[] = [];
  const omittedNoQuote: string[] = [];
  const omittedNoFee: string[] = [];
  const eligible = rows.filter((t) => {
    const dj = t.decisionJournal;
    if (!dj || dj.decision !== "paper_copy") { omittedNoJournal.push(t.id); return false; }
    const { allInPrice, fee, shares } = dj;
    const badQuote = allInPrice == null || fee == null || shares == null
      || !Number.isFinite(allInPrice) || !Number.isFinite(fee) || !Number.isFinite(shares)
      || shares <= 0 || fee < 0;
    if (badQuote) { omittedNoQuote.push(t.id); return false; }
    return true;
  });

  // --- Live fee model per unique token (helper caches per tokenId internally) ---
  const feeByToken = new Map<string, { model: FeeModel } | { error: string }>();
  const tokens = [...new Set(eligible.map((t) => t.tokenId).filter((x): x is string => !!x))];
  for (const token of tokens) {
    const market = eligible.find((t) => t.tokenId === token)!.marketId;
    try {
      feeByToken.set(token, { model: await getFeeModel(token, market) });
    } catch (e) {
      feeByToken.set(token, { error: (e as Error).message });
    }
    await new Promise((r) => setTimeout(r, FETCH_PACE_MS));
  }

  // --- Replay each eligible row ---
  const replayed: ReplayRow[] = [];
  for (const t of eligible) {
    const dj = t.decisionJournal!;
    const { allInPrice, fee, shares } = dj;
    const entry = dj.allInPrice ?? t.entryPrice ?? null;
    const feeRes = feeByToken.get(t.tokenId ?? "");
    if (!feeRes || "error" in feeRes) { omittedNoFee.push(t.id); continue; }
    const { model } = feeRes;

    const pRaw = (allInPrice! * shares! - fee!) / shares!;
    if (!(pRaw > 0 && pRaw < 1)) { omittedNoQuote.push(t.id); continue; } // inferred ask out of range

    const stake = t.simulatedPositionSize ?? allInPrice! * shares!;
    const terminal = dj.outcomeReview?.finalOutcome ?? t.currentPrice;
    if (terminal == null || !Number.isFinite(terminal)) { omittedNoQuote.push(t.id); continue; } // no settlement or mark

    let allInCorrected: number;
    let mode: Mode;
    if (model.exponent === 1 || model.rateBps === 0) {
      // Recorded quote already used this formula — preserve it exactly.
      allInCorrected = allInPrice!;
      mode = "preserved";
    } else {
      // Effective-average fee-only replay: same fee formula, live rate/exponent,
      // applied to the inferred raw average ask. NOT raw historical depth.
      allInCorrected = pRaw + takerFeePerShare(pRaw, model);
      mode = "replayed";
    }
    const sharesCorrected = stake / allInCorrected;
    const pnlCorrected = sharesCorrected * terminal - stake;
    const pnlPaper = t.status === "open" ? (t.unrealizedPnl ?? 0) : (t.realizedPnl ?? 0);

    replayed.push({
      id: t.id,
      slug: t.slug ?? "",
      status: t.status,
      segment: segmentBucket(dj.marketSegment),
      quality: qualityBucket(dj.walletQualityScore),
      entryBucket: entryBucket(entry),
      entry: entry ?? NaN,
      stake,
      pnlPaper,
      pnlCorrected,
      delta: pnlCorrected - pnlPaper,
      mode,
      rateBps: model.rateBps,
      exponent: model.exponent,
    });
  }

  // --- Output ---
  console.log("=".repeat(104));
  console.log("FEE REPLAY — wallet_copy paper trades since 2026-08-02T15:11:51.657Z (READ-ONLY)");
  console.log("=".repeat(104));

  // Status counts
  const countByStatus = (list: { status: string }[]) => {
    const c: Record<string, number> = {};
    for (const r of list) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  };
  const full = countByStatus(rows);
  const sel = countByStatus(eligible);
  const rep = countByStatus(replayed);
  console.log(`\n--- STATUS COUNTS ---`);
  console.log(`  modern wallet_copy set (n=${rows.length}): resolved=${full.resolved ?? 0} closed=${full.closed ?? 0} open=${full.open ?? 0}`);
  console.log(`  selected paper_copy  (n=${eligible.length}): resolved=${sel.resolved ?? 0} closed=${sel.closed ?? 0} open=${sel.open ?? 0}`);
  console.log(`  replayed             (n=${replayed.length}): resolved=${rep.resolved ?? 0} closed=${rep.closed ?? 0} open=${rep.open ?? 0}`);

  // Fee model distribution (live metadata) + failures
  console.log(`\n--- LIVE FEE MODEL DISTRIBUTION (${tokens.length} unique tokens) ---`);
  const dist = new Map<string, number>();
  const failures: string[] = [];
  for (const [token, res] of feeByToken) {
    if ("error" in res) { failures.push(token); continue; }
    const key = `rateBps=${res.model.rateBps} exponent=${res.model.exponent}`;
    dist.set(key, (dist.get(key) ?? 0) + 1);
  }
  for (const [key, n] of [...dist.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${key}: ${n}`);
  }
  if (failures.length) {
    console.log(`  fetch failures (${failures.length}): ${failures.map((f) => f.slice(0, 10)).join(", ")}`);
  } else {
    console.log(`  fetch failures: 0`);
  }

  // Omitted rows
  console.log(`\n--- ROWS OMITTED FROM REPLAY ---`);
  console.log(`  no journal (no DecisionJournal.decision="paper_copy"): ${omittedNoJournal.length}`);
  for (const id of omittedNoJournal) console.log(`    ${id.slice(0, 10)}`);
  console.log(`  no quote data (missing/invalid allInPrice|fee|shares, or no terminal mark): ${omittedNoQuote.length}`);
  for (const id of omittedNoQuote) console.log(`    ${id.slice(0, 10)}`);
  console.log(`  no fee data (missing tokenId or getFeeModel failed): ${omittedNoFee.length}`);
  for (const id of omittedNoFee) console.log(`    ${id.slice(0, 10)}`);

  // Per-row replay table (6 decimals to establish the exact delta)
  console.log(`\n--- PER-ROW REPLAY ---`);
  console.log(`${"id".padEnd(11)} ${"status".padEnd(8)} ${"seg".padEnd(15)} ${"entry".padStart(8)} ${"stake".padStart(7)} ${"paperPnl".padStart(13)} ${"corrPnl".padStart(13)} ${"delta".padStart(13)} mode`);
  for (const r of replayed) {
    const mode = r.mode === "preserved"
      ? `preserved(rate=${r.rateBps},exp=${r.exponent})`
      : `effective-avg replay(rate=${r.rateBps},exp=${r.exponent})`;
    console.log(
      `${r.id.slice(0, 10).padEnd(11)} ${r.status.padEnd(8)} ${r.segment.padEnd(15)} ` +
      `${(Number.isFinite(r.entry) ? r.entry : 0).toFixed(6).padStart(8)} ${r.stake.toFixed(2).padStart(7)} ` +
      `${usd6(r.pnlPaper).padStart(13)} ${usd6(r.pnlCorrected).padStart(13)} ${usd6(r.delta).padStart(13)} ${mode}`,
    );
  }

  // Aggregate helper
  const summarize = (label: string, list: ReplayRow[]): void => {
    if (!list.length) {
      console.log(`${label.padEnd(16)} ${String(0).padStart(4)} ${"0.00".padStart(9)} ${usd6(0).padStart(13)} ${usd6(0).padStart(13)} ${usd6(0).padStart(13)} ${"n/a".padStart(9)} ${"n/a".padStart(9)}`);
      return;
    }
    const stake = list.reduce((s, r) => s + r.stake, 0);
    const paper = list.reduce((s, r) => s + r.pnlPaper, 0);
    const corr = list.reduce((s, r) => s + r.pnlCorrected, 0);
    console.log(
      `${label.padEnd(16)} ${String(list.length).padStart(4)} ${stake.toFixed(2).padStart(9)} ` +
      `${usd6(paper).padStart(13)} ${usd6(corr).padStart(13)} ${usd6(corr - paper).padStart(13)} ` +
      `${pct4(paper, stake).padStart(9)} ${pct4(corr, stake).padStart(9)}`,
    );
  };

  const dim = (rows: ReplayRow[], key: "segment" | "quality" | "entryBucket", buckets: [string, string][]) => {
    for (const [label, test] of buckets) {
      const g = rows.filter((r) => r[key] === test);
      summarize(label, g);
    }
    summarize("total", rows);
  };

  console.log(`\n--- AGGREGATES: marketSegment (journal decision-time) ---`);
  console.log(`${"bucket".padEnd(16)} ${"n".padStart(4)} ${"stake".padStart(9)} ${"paperPnl".padStart(13)} ${"corrPnl".padStart(13)} ${"delta".padStart(13)} ${"ROIpaper".padStart(9)} ${"ROIcorr".padStart(9)}`);
  dim(replayed, "segment", [["sports_mainline", "sports_mainline"], ["tennis", "tennis"], ["other", "other"]]);

  console.log(`\n--- AGGREGATES: walletQualityScore (journal decision-time) ---`);
  console.log(`${"bucket".padEnd(16)} ${"n".padStart(4)} ${"stake".padStart(9)} ${"paperPnl".padStart(13)} ${"corrPnl".padStart(13)} ${"delta".padStart(13)} ${"ROIpaper".padStart(9)} ${"ROIcorr".padStart(9)}`);
  dim(replayed, "quality", [["<35", "<35"], [">=35", ">=35"], ["unknown", "unknown"]]);

  console.log(`\n--- AGGREGATES: decision-time executable entry (allInPrice fallback entryPrice) ---`);
  console.log(`${"bucket".padEnd(16)} ${"n".padStart(4)} ${"stake".padStart(9)} ${"paperPnl".padStart(13)} ${"corrPnl".padStart(13)} ${"delta".padStart(13)} ${"ROIpaper".padStart(9)} ${"ROIcorr".padStart(9)}`);
  dim(replayed, "entryBucket", [["<0.75", "<0.75"], [">=0.75", ">=0.75"], ["unknown", "unknown"]]);

  // Conclusion
  const stakeT = replayed.reduce((s, r) => s + r.stake, 0);
  const paperT = replayed.reduce((s, r) => s + r.pnlPaper, 0);
  const corrT = replayed.reduce((s, r) => s + r.pnlCorrected, 0);
  const deltaT = corrT - paperT;
  const nReplay = replayed.filter((r) => r.mode === "replayed").length;
  console.log(`\n--- CONCLUSION ---`);
  console.log(`  Replayed ${replayed.length} of ${rows.length} modern wallet_copy trades.`);
  console.log(`  Paper PnL:   ${usd6(paperT)}  (ROI ${pct4(paperT, stakeT)})`);
  console.log(`  Fee-corrected PnL: ${usd6(corrT)}  (ROI ${pct4(corrT, stakeT)})`);
  console.log(`  Delta: ${usd6(deltaT)} (corrected - paper)`);
  if (nReplay === 0) {
    console.log(`  All ${replayed.length} rows had exponent=1 or rate=0, so every recorded quote was already`);
    console.log(`  computed with the current fee formula — no fee correction applies (deltas ~0).`);
  } else {
    console.log(`  ${nReplay} row(s) used a non-1 exponent: their correction is an effective-average fee-only`);
    console.log(`  replay at the inferred raw ask (allInPrice*shares - fee)/shares with stake fixed — NOT a`);
    console.log(`  reconstruction of raw historical order-book depth.`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

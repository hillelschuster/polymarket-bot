/**
 * RESEARCH MODULE — Wallet Intelligence
 * 
 * Queries Polymarket's closed-positions and current-positions endpoints
 * for tracked wallets. Computes realized sports ROI, wallet tiers, and
 * copyability metrics. READ-ONLY — does not modify the main pipeline.
 * 
 * Usage: npx tsx src/research/walletIntel.ts
 */
import { prisma } from "../lib/db.js";

const DATA_API = "https://data-api.polymarket.com";

// --- Types ---
interface ClosedPosition {
  proxyWallet: string;
  conditionId: string;
  avgPrice: number;
  totalBought: number;
  realizedPnl: number;
  curPrice: number;
  timestamp: number;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  endDate: string;
}

interface CurrentPosition {
  proxyWallet: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  curPrice: number;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
}

interface WalletIntel {
  address: string;
  label: string | null;
  rank: number | null;
  globalScore: number | null;
  // Closed sports positions
  closedSportsCount: number;
  closedSportsPnl: number;
  closedSportsRoi: number;
  closedSportsWinRate: number;
  medianSportsPositionNotional: number;
  // Current positions
  openSportsCount: number;
  openSportsValue: number;
  // Our copy record
  ourCopyCount: number;
  ourCopyPnl: number;
  ourCopyWinRate: number;
  // Tier assignment
  tier: "A" | "B" | "C" | "DROP";
  tierReason: string;
}

// --- Sports slug detection ---
const SPORTS_PREFIXES = new Set([
  "mlb", "nba", "nfl", "nhl", "epl", "ucl", "mex", "mls", "fifa", "fifwc",
  "wnba", "ncaaf", "ncaab", "tennis", "golf", "ufc", "boxing", "f1", "nascar",
  "atp", "wta", "itf", "challenger",
]);

function isSportsSlug(slug: string | null | undefined): boolean {
  if (!slug) return false;
  const prefix = slug.split("-")[0].toLowerCase();
  return SPORTS_PREFIXES.has(prefix);
}

// --- API calls ---
async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "content-type": "application/json" } });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function getClosedPositions(address: string): Promise<ClosedPosition[]> {
  const all: ClosedPosition[] = [];
  for (let offset = 0; offset < 500; offset += 50) {
    const qs = new URLSearchParams({
      user: address,
      limit: "50",
      offset: String(offset),
      sortBy: "REALIZEDPNL",
      sortDirection: "DESC",
    });
    const page = await fetchJson<ClosedPosition[]>(`${DATA_API}/closed-positions?${qs}`);
    all.push(...page);
    if (page.length < 50) break;
    await new Promise((r) => setTimeout(r, 250)); // rate limit
  }
  return all;
}

async function getCurrentPositions(address: string): Promise<CurrentPosition[]> {
  const qs = new URLSearchParams({
    user: address,
    limit: "500",
    sortBy: "CURRENT",
    sortDirection: "DESC",
  });
  return fetchJson<CurrentPosition[]>(`${DATA_API}/positions?${qs}`);
}

// --- Main ---
async function main() {
  console.log("=== WALLET INTELLIGENCE REPORT ===\n");

  // Get wallets we care about: tracked + those with copies
  const tracked = await prisma.walletProfile.findMany({
    where: { status: { in: ["track", "watch"] } },
    orderBy: { globalScore: { sort: "desc", nulls: "last" } },
    take: 40,
  });

  // Also include wallets that have paper trades (proven by us)
  const copyWallets = await prisma.paperTrade.findMany({
    where: { source: "wallet_copy" },
    select: { walletAddress: true },
    distinct: ["walletAddress"],
  });
  const copyAddrs = new Set(copyWallets.map((c) => c.walletAddress));
  const allAddrs = new Set(tracked.map((w) => w.address));
  for (const addr of copyAddrs) allAddrs.add(addr);

  console.log(`Analyzing ${allAddrs.size} wallets (${tracked.length} tracked + ${copyAddrs.size} with copies)\n`);

  const results: WalletIntel[] = [];

  for (const addr of allAddrs) {
    const profile = tracked.find((w) => w.address === addr);
    try {
      // Fetch closed positions
      const closed = await getClosedPositions(addr);
      await new Promise((r) => setTimeout(r, 300));

      // Fetch current positions
      const current = await getCurrentPositions(addr);
      await new Promise((r) => setTimeout(r, 300));

      // Filter to sports
      const closedSports = closed.filter((p) => isSportsSlug(p.slug));
      const openSports = current.filter((p) => isSportsSlug(p.slug));

      // Compute metrics
      const sportsPnl = closedSports.reduce((s, p) => s + p.realizedPnl, 0);
      const sportsInvested = closedSports.reduce((s, p) => s + p.totalBought * p.avgPrice, 0);
      const sportsWins = closedSports.filter((p) => p.realizedPnl > 0).length;
      const sportsWinRate = closedSports.length ? sportsWins / closedSports.length : 0;
      const notionals = closedSports.map((p) => p.totalBought * p.avgPrice).sort((a, b) => a - b);
      const medianNotional = notionals.length ? notionals[Math.floor(notionals.length / 2)] : 0;

      // Our copy record for this wallet
      const ourCopies = await prisma.paperTrade.findMany({
        where: { walletAddress: addr, source: "wallet_copy" },
      });
      const ourPnl = ourCopies.reduce((s, t) => {
        return s + (t.status !== "open" ? (t.realizedPnl ?? 0) : (t.unrealizedPnl ?? 0));
      }, 0);
      const ourWins = ourCopies.filter((t) => {
        const pnl = t.status !== "open" ? (t.realizedPnl ?? 0) : (t.unrealizedPnl ?? 0);
        return pnl > 0;
      }).length;
      const ourWinRate = ourCopies.length ? ourWins / ourCopies.length : 0;
      const ourResolved = ourCopies.filter((t) => t.status === "resolved");
      const ourResolvedPnl = ourResolved.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);

      // Tier assignment
      let tier: "A" | "B" | "C" | "DROP" = "B";
      let tierReason = "";

      if (ourResolved.length >= 3 && ourResolvedPnl > 0 && ourWinRate >= 0.5) {
        tier = "C"; // Proven by us directly
        tierReason = `${ourResolved.length} resolved copies, PnL $${ourResolvedPnl.toFixed(2)}, ${Math.round(ourWinRate * 100)}% win`;
      } else if (closedSports.length >= 10 && sportsPnl > 0) {
        tier = "A"; // Proven on Polymarket
        tierReason = `${closedSports.length} closed sports, ROI ${(sportsInvested > 0 ? (sportsPnl / sportsInvested * 100) : 0).toFixed(1)}%, ${Math.round(sportsWinRate * 100)}% win`;
      } else if (ourResolved.length >= 5 && ourResolvedPnl < 0) {
        tier = "DROP";
        tierReason = `${ourResolved.length} resolved copies, net loss $${ourResolvedPnl.toFixed(2)}`;
      } else if (closedSports.length > 0 && closedSports.length < 10) {
        tier = "B";
        tierReason = `${closedSports.length} closed sports (insufficient history)`;
      } else {
        tier = "B";
        tierReason = "no closed sports history";
      }

      // Override: if our copies prove it, that trumps public data
      if (ourResolved.length >= 3 && ourResolvedPnl > 0 && ourWinRate >= 0.5 && tier !== "A") {
        tier = "C";
        tierReason = `OUR COPIES: ${ourResolved.length} resolved, $${ourResolvedPnl.toFixed(2)}, ${Math.round(ourWinRate * 100)}% win`;
      }

      results.push({
        address: addr,
        label: profile?.label ?? null,
        rank: profile?.sourceRank ?? null,
        globalScore: profile?.globalScore ?? null,
        closedSportsCount: closedSports.length,
        closedSportsPnl: Math.round(sportsPnl * 100) / 100,
        closedSportsRoi: sportsInvested > 0 ? Math.round((sportsPnl / sportsInvested) * 10000) / 100 : 0,
        closedSportsWinRate: Math.round(sportsWinRate * 100) / 100,
        medianSportsPositionNotional: Math.round(medianNotional),
        openSportsCount: openSports.length,
        openSportsValue: Math.round(openSports.reduce((s, p) => s + p.currentValue, 0) * 100) / 100,
        ourCopyCount: ourCopies.length,
        ourCopyPnl: Math.round(ourPnl * 100) / 100,
        ourCopyWinRate: Math.round(ourWinRate * 100) / 100,
        tier,
        tierReason,
      });
    } catch (err) {
      console.error(`  Error for ${addr.slice(0, 10)}...: ${(err as Error).message}`);
    }
  }

  // Sort by tier then PnL
  const tierOrder = { A: 0, C: 1, B: 2, DROP: 3 };
  results.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier] || b.closedSportsPnl - a.closedSportsPnl);

  // Print report
  console.log("TIER | WALLET           | RANK | SCORE | CLOSED | ROI%  | WIN%  | MEDIAN$ | OUR COPIES | OUR PnL  | REASON");
  console.log("-".repeat(140));
  for (const w of results) {
    const addr = w.label || w.address.slice(0, 10) + "...";
    console.log(
      `  ${w.tier}  | ${addr.padEnd(16)} | ${String(w.rank ?? "?").padStart(4)} | ${String(w.globalScore?.toFixed(0) ?? "?").padStart(5)} | ${String(w.closedSportsCount).padStart(6)} | ${String(w.closedSportsRoi).padStart(5)} | ${String(Math.round(w.closedSportsWinRate * 100)).padStart(4)}% | $${String(w.medianSportsPositionNotional).padStart(6)} | ${String(w.ourCopyCount).padStart(10)} | $${String(w.ourCopyPnl).padStart(7)} | ${w.tierReason}`
    );
  }

  // Summary
  const tierA = results.filter((r) => r.tier === "A");
  const tierC = results.filter((r) => r.tier === "C");
  const tierB = results.filter((r) => r.tier === "B");
  const drop = results.filter((r) => r.tier === "DROP");
  console.log(`\n=== SUMMARY ===`);
  console.log(`Tier A (proven public): ${tierA.length} wallets`);
  console.log(`Tier C (proven by us):  ${tierC.length} wallets`);
  console.log(`Tier B (exploratory):   ${tierB.length} wallets`);
  console.log(`DROP:                   ${drop.length} wallets`);
  console.log(`\nTotal closed sports PnL across all wallets: $${results.reduce((s, r) => s + r.closedSportsPnl, 0).toFixed(2)}`);
  console.log(`Total our copy PnL: $${results.reduce((s, r) => s + r.ourCopyPnl, 0).toFixed(2)}`);
}

main().catch(console.error);

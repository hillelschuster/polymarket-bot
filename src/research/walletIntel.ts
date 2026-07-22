/**
 * RESEARCH MODULE — Wallet Intelligence
 * READ-ONLY: queries public Polymarket APIs and local Prisma tables.
 * Usage: npx tsx src/research/walletIntel.ts
 */
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import { prisma } from "../lib/db.js";

const DATA_API = "https://data-api.polymarket.com";
const MAX_CLOSED_POSITIONS = 500;
const API_CONCURRENCY = 5;
const EPSILON = 0.005;

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
  eventSlug?: string;
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
  eventSlug?: string;
  outcome: string;
  outcomeIndex: number;
}

export type WalletTier = "A" | "B" | "C" | "DROP";

interface WalletProfileRow {
  address: string;
  label: string | null;
  sourceRank: number | null;
  globalScore: number | null;
}

interface PaperCopyRow {
  walletAddress: string;
  simulatedPositionSize: number | null;
  status: string;
  realizedPnl: number | null;
}

export interface WalletIntel {
  address: string;
  label: string | null;
  rank: number | null;
  globalScore: number | null;
  closedSportsCount: number;
  closedSportsPnl: number;
  closedSportsRoi: number;
  closedSportsWinRate: number;
  closedSportsProfitFactor: number | null;
  medianSportsPositionNotional: number;
  openSportsCount: number;
  openSportsValue: number;
  ourCopyCount: number;
  ourResolvedCopyCount: number;
  ourResolvedCopyPnl: number;
  ourResolvedCopyRoi: number;
  ourResolvedCopyWinRate: number;
  evidenceScore: number;
  tier: WalletTier;
  tierReason: string;
}

export interface WalletIntelReport {
  generatedAt: string;
  wallets: WalletIntel[];
  errors: { address: string; error: string }[];
  tierCounts: Record<WalletTier, number>;
}

const SPORTS_PREFIXES = [
  "mlb", "nba", "nfl", "nhl", "wnba", "ncaaf", "ncaab", "cfb", "cbb",
  "epl", "ucl", "uel", "mls", "mex", "liga-mx", "la-liga", "serie-a",
  "bundesliga", "ligue-1", "eredivisie", "primeira-liga", "fifa", "fifwc",
  "atp", "wta", "itf", "challenger", "tennis", "golf", "ufc", "boxing",
  "f1", "nascar", "cricket", "ipl", "cs2", "lol", "dota2", "valorant",
];

function isSportsSlug(slug: string | null | undefined, eventSlug?: string | null): boolean {
  const values = [slug, eventSlug].filter((value): value is string => Boolean(value));
  return values.some((value) => {
    const normalized = value.toLowerCase();
    return SPORTS_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}-`));
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function winRate(pnls: number[]): number {
  const decisive = pnls.filter((pnl) => Math.abs(pnl) > EPSILON);
  if (!decisive.length) return 0;
  return decisive.filter((pnl) => pnl > 0).length / decisive.length;
}

function profitFactor(pnls: number[]): number | null {
  const gains = pnls.filter((pnl) => pnl > 0).reduce((sum, pnl) => sum + pnl, 0);
  const losses = Math.abs(pnls.filter((pnl) => pnl < 0).reduce((sum, pnl) => sum + pnl, 0));
  if (losses <= EPSILON) return gains > EPSILON ? null : 0;
  return gains / losses;
}

function publicEvidenceScore(count: number, roiPct: number, wins: number, factor: number | null): number {
  const sample = Math.min(1, count / 25);
  const quality = 50
    + clamp(roiPct, -20, 20) * 1.4
    + clamp((wins - 0.5) * 100, -25, 25)
    + clamp(((factor ?? 3) - 1) * 12, -18, 24);
  return clamp(50 + (quality - 50) * sample, 0, 100);
}

function copyEvidenceScore(count: number, roiPct: number, wins: number): number {
  const sample = Math.min(1, count / 10);
  const quality = 50 + clamp(roiPct, -30, 30) * 1.3 + clamp((wins - 0.5) * 120, -30, 30);
  return clamp(50 + (quality - 50) * sample, 0, 100);
}

function assignTier(input: {
  publicCount: number;
  publicPnl: number;
  publicRoi: number;
  publicWinRate: number;
  publicProfitFactor: number | null;
  copyCount: number;
  copyPnl: number;
  copyRoi: number;
  copyWinRate: number;
}): { tier: WalletTier; reason: string; score: number } {
  const publicScore = publicEvidenceScore(
    input.publicCount,
    input.publicRoi,
    input.publicWinRate,
    input.publicProfitFactor,
  );
  const copyScore = copyEvidenceScore(input.copyCount, input.copyRoi, input.copyWinRate);
  const copyWeight = 0.75 * Math.min(1, input.copyCount / 8);
  const score = round(publicScore * (1 - copyWeight) + copyScore * copyWeight, 1);

  const copyClearlyBad = input.copyCount >= 4
    && (input.copyPnl < 0)
    && (input.copyRoi <= -3 || input.copyWinRate < 0.4);
  const publicClearlyBad = input.copyCount < 4
    && input.publicCount >= 20
    && input.publicPnl < 0
    && input.publicRoi <= -3
    && input.publicWinRate < 0.48;

  if (copyClearlyBad || publicClearlyBad) {
    const reason = copyClearlyBad
      ? `our resolved copies dominate: ${input.copyCount}, ROI ${input.copyRoi.toFixed(1)}%, win ${Math.round(input.copyWinRate * 100)}%`
      : `public sports record weak: ${input.publicCount}, ROI ${input.publicRoi.toFixed(1)}%, win ${Math.round(input.publicWinRate * 100)}%`;
    return { tier: "DROP", reason, score };
  }

  const ownProof = input.copyCount >= 5
    && input.copyPnl > 0
    && input.copyRoi >= 2
    && input.copyWinRate >= 0.55;
  if (ownProof) {
    return {
      tier: "A",
      reason: `our resolved copies: ${input.copyCount}, PnL $${input.copyPnl.toFixed(2)}, ROI ${input.copyRoi.toFixed(1)}%, win ${Math.round(input.copyWinRate * 100)}%`,
      score,
    };
  }

  const publicProof = input.publicCount >= 15
    && input.publicPnl > 0
    && input.publicRoi >= 1.5
    && input.publicWinRate >= 0.52
    && (input.publicProfitFactor == null || input.publicProfitFactor >= 1.2);
  const earlyOwnSupport = input.copyCount >= 3 && input.copyPnl > 0 && input.copyWinRate >= 0.5;
  if (publicProof || earlyOwnSupport) {
    const reason = earlyOwnSupport
      ? `early copy support: ${input.copyCount} resolved, PnL $${input.copyPnl.toFixed(2)}, win ${Math.round(input.copyWinRate * 100)}%`
      : `public sports record: ${input.publicCount}, ROI ${input.publicRoi.toFixed(1)}%, win ${Math.round(input.publicWinRate * 100)}%, PF ${input.publicProfitFactor?.toFixed(2) ?? "∞"}`;
    return { tier: "B", reason, score };
  }

  const reason = input.publicCount > 0
    ? `exploratory: ${input.publicCount} public sports positions, ${input.copyCount} resolved copies`
    : `insufficient sports evidence: ${input.copyCount} resolved copies`;
  return { tier: "C", reason, score };
}

async function fetchJson<T>(url: string, retries = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(url, {
        headers: { "content-type": "application/json" },
        signal: controller.signal,
      });
      if (response.ok) return response.json() as Promise<T>;
      const body = await response.text();
      if (response.status !== 429 && response.status < 500) throw new Error(`API ${response.status}: ${body}`);
      lastError = new Error(`API ${response.status}: ${body}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function getClosedPositions(address: string): Promise<ClosedPosition[]> {
  const positions: ClosedPosition[] = [];
  for (let offset = 0; offset < MAX_CLOSED_POSITIONS; offset += 50) {
    const query = new URLSearchParams({
      user: address,
      limit: "50",
      offset: String(offset),
      sortBy: "TIMESTAMP",
      sortDirection: "DESC",
    });
    const page = await fetchJson<ClosedPosition[]>(`${DATA_API}/closed-positions?${query}`);
    positions.push(...page);
    if (page.length < 50) break;
  }
  return positions;
}

async function getCurrentPositions(address: string): Promise<CurrentPosition[]> {
  const query = new URLSearchParams({
    user: address,
    limit: "500",
    offset: "0",
    sortBy: "CURRENT",
    sortDirection: "DESC",
  });
  return fetchJson<CurrentPosition[]>(`${DATA_API}/positions?${query}`);
}

async function mapConcurrent<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function runWorker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runWorker()));
  return results;
}

export async function analyzeWalletIntel(): Promise<WalletIntelReport> {
  const [trackedRaw, copiesRaw] = await Promise.all([
    prisma.walletProfile.findMany({
      where: { status: { in: ["track", "watch"] } },
      orderBy: { globalScore: { sort: "desc", nulls: "last" } },
      take: 40,
    }),
    prisma.paperTrade.findMany({
      where: { source: "wallet_copy" },
      select: {
        walletAddress: true,
        simulatedPositionSize: true,
        status: true,
        realizedPnl: true,
      },
    }),
  ]);
  const tracked = trackedRaw as WalletProfileRow[];
  const copies = copiesRaw as PaperCopyRow[];

  const profileByAddress = new Map(tracked.map((profile) => [profile.address.toLowerCase(), profile]));
  const copiesByAddress = new Map<string, PaperCopyRow[]>();
  for (const copy of copies) {
    const key = copy.walletAddress.toLowerCase();
    const list = copiesByAddress.get(key) ?? [];
    list.push(copy);
    copiesByAddress.set(key, list);
  }

  const addresses = [...new Set([
    ...tracked.map((profile) => profile.address.toLowerCase()),
    ...copies.map((copy) => copy.walletAddress.toLowerCase()),
  ])];
  const errors: WalletIntelReport["errors"] = [];

  const analyzed = await mapConcurrent(addresses, API_CONCURRENCY, async (address): Promise<WalletIntel | null> => {
    try {
      const [closed, current] = await Promise.all([
        getClosedPositions(address),
        getCurrentPositions(address),
      ]);
      const profile = profileByAddress.get(address);
      const walletCopies = copiesByAddress.get(address) ?? [];
      const closedSports = closed.filter((position) => isSportsSlug(position.slug, position.eventSlug));
      const openSports = current.filter((position) => isSportsSlug(position.slug, position.eventSlug));

      const publicPnls = closedSports.map((position) => Number(position.realizedPnl) || 0);
      const publicPnl = publicPnls.reduce((sum, pnl) => sum + pnl, 0);
      const publicCost = closedSports.reduce((sum, position) => {
        const cost = Number(position.totalBought) * Number(position.avgPrice);
        return sum + (Number.isFinite(cost) && cost > 0 ? cost : 0);
      }, 0);
      const publicRoi = publicCost > 0 ? publicPnl / publicCost * 100 : 0;
      const publicWinRate = winRate(publicPnls);
      const publicProfitFactor = profitFactor(publicPnls);

      const resolvedCopies = walletCopies.filter((copy) => copy.status === "resolved");
      const copyPnls = resolvedCopies.map((copy) => Number(copy.realizedPnl) || 0);
      const copyPnl = copyPnls.reduce((sum, pnl) => sum + pnl, 0);
      const copyCapital = resolvedCopies.reduce((sum, copy) => {
        const size = Number(copy.simulatedPositionSize);
        return sum + (Number.isFinite(size) && size > 0 ? size : 0);
      }, 0);
      const copyRoi = copyCapital > 0 ? copyPnl / copyCapital * 100 : 0;
      const copyWinRate = winRate(copyPnls);

      const tier = assignTier({
        publicCount: closedSports.length,
        publicPnl,
        publicRoi,
        publicWinRate,
        publicProfitFactor,
        copyCount: resolvedCopies.length,
        copyPnl,
        copyRoi,
        copyWinRate,
      });

      return {
        address,
        label: profile?.label ?? null,
        rank: profile?.sourceRank ?? null,
        globalScore: profile?.globalScore ?? null,
        closedSportsCount: closedSports.length,
        closedSportsPnl: round(publicPnl),
        closedSportsRoi: round(publicRoi),
        closedSportsWinRate: round(publicWinRate, 4),
        closedSportsProfitFactor: publicProfitFactor == null ? null : round(publicProfitFactor),
        medianSportsPositionNotional: round(median(closedSports.map((position) => {
          const value = Number(position.totalBought) * Number(position.avgPrice);
          return Number.isFinite(value) && value > 0 ? value : 0;
        }).filter((value) => value > 0))),
        openSportsCount: openSports.length,
        openSportsValue: round(openSports.reduce((sum, position) => sum + (Number(position.currentValue) || 0), 0)),
        ourCopyCount: walletCopies.length,
        ourResolvedCopyCount: resolvedCopies.length,
        ourResolvedCopyPnl: round(copyPnl),
        ourResolvedCopyRoi: round(copyRoi),
        ourResolvedCopyWinRate: round(copyWinRate, 4),
        evidenceScore: tier.score,
        tier: tier.tier,
        tierReason: tier.reason,
      };
    } catch (error) {
      errors.push({ address, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  });

  const tierOrder: Record<WalletTier, number> = { A: 0, B: 1, C: 2, DROP: 3 };
  const wallets = analyzed
    .filter((wallet): wallet is WalletIntel => wallet !== null)
    .sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier] || b.evidenceScore - a.evidenceScore);
  const tierCounts: Record<WalletTier, number> = { A: 0, B: 0, C: 0, DROP: 0 };
  for (const wallet of wallets) tierCounts[wallet.tier]++;

  return { generatedAt: new Date().toISOString(), wallets, errors, tierCounts };
}

export function printWalletIntelReport(report: WalletIntelReport): void {
  console.log("=== WALLET INTELLIGENCE REPORT ===\n");
  console.log("TIER | SCORE | WALLET           | PUBLIC N | ROI%   | WIN% | PF    | OUR RES | OUR ROI% | OUR PnL | REASON");
  console.log("-".repeat(150));
  for (const wallet of report.wallets) {
    const name = (wallet.label || `${wallet.address.slice(0, 10)}...`).slice(0, 16);
    console.log(
      `  ${wallet.tier.padEnd(4)}| ${wallet.evidenceScore.toFixed(1).padStart(5)} | ${name.padEnd(16)} | ${String(wallet.closedSportsCount).padStart(8)} | ${wallet.closedSportsRoi.toFixed(1).padStart(6)} | ${(wallet.closedSportsWinRate * 100).toFixed(0).padStart(3)}% | ${(wallet.closedSportsProfitFactor?.toFixed(2) ?? "inf").padStart(5)} | ${String(wallet.ourResolvedCopyCount).padStart(7)} | ${wallet.ourResolvedCopyRoi.toFixed(1).padStart(8)} | $${wallet.ourResolvedCopyPnl.toFixed(2).padStart(7)} | ${wallet.tierReason}`,
    );
  }
  console.log("\n=== SUMMARY ===");
  console.log(`Tier A (our copy record proves edge): ${report.tierCounts.A}`);
  console.log(`Tier B (strong/early evidence):       ${report.tierCounts.B}`);
  console.log(`Tier C (exploratory):                 ${report.tierCounts.C}`);
  console.log(`DROP:                                 ${report.tierCounts.DROP}`);
  if (report.errors.length) console.log(`API failures:                          ${report.errors.length}`);
}

function isDirectRun(): boolean {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isDirectRun()) {
  analyzeWalletIntel()
    .then(printWalletIntelReport)
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

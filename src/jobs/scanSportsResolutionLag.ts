import WebSocket from "ws";
import {
  GAMMA_API,
  fetchJson,
  getFeeRateBps,
  getOrderBook,
  quoteBuyCash,
} from "../adapters/polymarket.js";

const SPORTS_WS = "wss://sports-api.polymarket.com/ws";
const CASH_BUDGET = Number(process.env.LANEB_CASH_BUDGET ?? 10);
const MIN_ALL_IN = Number(process.env.LANEB_MIN_ALL_IN ?? 0.90);
const MAX_ALL_IN = Number(process.env.LANEB_MAX_ALL_IN ?? 0.985);
const MAX_SPREAD = Number(process.env.LANEB_MAX_SPREAD ?? 0.02);
const MIN_ROI = Number(process.env.LANEB_MIN_ROI ?? 0.01);
const CONFIRM_DELAY_MS = Number(process.env.LANEB_CONFIRM_DELAY_MS ?? 8_000);
const RECHECK_MS = Number(process.env.LANEB_RECHECK_MS ?? 15_000);
const MAX_RECHECKS = Number(process.env.LANEB_MAX_RECHECKS ?? 20);

interface SportResult {
  slug: string;
  gameId?: string | number;
  leagueAbbreviation?: string;
  homeTeam?: string;
  awayTeam?: string;
  status?: string;
  score?: string;
  ended?: boolean;
  live?: boolean;
  finished_timestamp?: string;
}

interface GammaSportsMarket {
  id?: string;
  conditionId?: string;
  question?: string;
  sportsMarketType?: string;
  line?: number | string | null;
  outcomes?: string[] | string;
  outcomePrices?: string[] | string;
  clobTokenIds?: string[] | string;
  acceptingOrders?: boolean;
  enableOrderBook?: boolean;
  closed?: boolean;
}

interface GammaSportsEvent {
  slug?: string;
  title?: string;
  score?: string;
  ended?: boolean;
  finishedTimestamp?: string;
  gameStatus?: string;
  markets?: GammaSportsMarket[];
}

interface WinnerToken {
  market: GammaSportsMarket;
  outcome: string;
  tokenId: string;
  winner: string;
}

const running = new Set<string>();
const emitted = new Set<string>();

function parseList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function normalize(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function parseFinalScore(score: string | undefined): [number, number] | null {
  if (!score) return null;
  const matches = [...score.matchAll(/(\d+)\s*-\s*(\d+)/g)];
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  const home = Number(last[1]);
  const away = Number(last[2]);
  return Number.isFinite(home) && Number.isFinite(away) ? [home, away] : null;
}

function isTerminal(result: SportResult): boolean {
  if (!result.ended) return false;
  const status = normalize(result.status);
  return status === "final" || status === "f ot" || status === "f so" || status === "finished" || status === "awarded";
}

function teamMention(text: string, team: string): boolean {
  const t = normalize(team);
  if (!t) return false;
  return (` ${normalize(text)} `).includes(` ${t} `);
}

function pickWinnerToken(event: GammaSportsEvent, result: SportResult): WinnerToken | null {
  const score = parseFinalScore(event.score ?? result.score);
  if (!score || score[0] === score[1]) return null;

  const winner = score[0] > score[1] ? result.homeTeam : result.awayTeam;
  const loser = score[0] > score[1] ? result.awayTeam : result.homeTeam;
  if (!winner || !loser) return null;

  for (const market of event.markets ?? []) {
    if (market.closed || market.acceptingOrders === false || market.enableOrderBook === false) continue;

    const type = normalize(market.sportsMarketType);
    const question = market.question ?? "";
    const forbidden = /spread|handicap|total|over under|both teams|margin|points/i;
    const winnerType = /moneyline|match winner|winner|h2h/.test(type);
    const yesNoWinMarket = /\bwin\b/i.test(question);
    if ((!winnerType && !yesNoWinMarket) || forbidden.test(`${type} ${question}`)) continue;
    if (market.line != null && Number(market.line) !== 0) continue;

    const outcomes = parseList(market.outcomes);
    const tokenIds = parseList(market.clobTokenIds);
    if (outcomes.length !== 2 || tokenIds.length !== 2) continue;

    let index = outcomes.findIndex((outcome) => teamMention(outcome, winner));
    if (index < 0) {
      const yes = outcomes.findIndex((outcome) => normalize(outcome) === "yes");
      const no = outcomes.findIndex((outcome) => normalize(outcome) === "no");
      if (yes >= 0 && no >= 0 && teamMention(question, winner)) index = yes;
      else if (yes >= 0 && no >= 0 && teamMention(question, loser)) index = no;
    }

    if (index >= 0 && tokenIds[index]) {
      return { market, outcome: outcomes[index], tokenId: tokenIds[index], winner };
    }
  }
  return null;
}

async function evaluate(result: SportResult): Promise<"trade" | "retry" | "stop"> {
  const event = await fetchJson<GammaSportsEvent>(`${GAMMA_API}/events/slug/${encodeURIComponent(result.slug)}`);
  if (event.ended !== true || !parseFinalScore(event.score ?? result.score)) return "retry";

  const selected = pickWinnerToken(event, result);
  if (!selected) {
    console.log(`[SKIP] ${result.slug}: no unambiguous moneyline winner token`);
    return "stop";
  }

  const [book, feeRateBps] = await Promise.all([
    getOrderBook(selected.tokenId),
    getFeeRateBps(selected.tokenId),
  ]);
  const quote = quoteBuyCash(book, feeRateBps, CASH_BUDGET);
  if (!quote) return "retry";

  const profitAtRedemption = quote.shares - quote.cashCost;
  const roi = profitAtRedemption / quote.cashCost;
  const spread = quote.spread ?? Infinity;
  const key = `${result.slug}|${selected.tokenId}`;

  const reasons: string[] = [];
  if (quote.allInPrice < MIN_ALL_IN) reasons.push(`allIn ${quote.allInPrice.toFixed(4)} < ${MIN_ALL_IN}`);
  if (quote.allInPrice > MAX_ALL_IN) reasons.push(`allIn ${quote.allInPrice.toFixed(4)} > ${MAX_ALL_IN}`);
  if (spread > MAX_SPREAD) reasons.push(`spread ${spread.toFixed(4)} > ${MAX_SPREAD}`);
  if (roi < MIN_ROI) reasons.push(`ROI ${(roi * 100).toFixed(2)}% < ${(MIN_ROI * 100).toFixed(2)}%`);

  if (reasons.length) {
    console.log(`[SKIP] ${result.slug}: ${reasons.join("; ")}`);
    return quote.allInPrice > MAX_ALL_IN ? "stop" : "retry";
  }

  if (!emitted.has(key)) {
    emitted.add(key);
    console.log(JSON.stringify({
      decision: "WOULD_BUY",
      strategy: "sports_resolution_lag",
      slug: result.slug,
      status: result.status,
      score: event.score ?? result.score,
      winner: selected.winner,
      outcome: selected.outcome,
      tokenId: selected.tokenId,
      cashBudget: CASH_BUDGET,
      bestAsk: quote.bestAsk,
      allInPrice: Number(quote.allInPrice.toFixed(6)),
      spread: Number(spread.toFixed(6)),
      shares: Number(quote.shares.toFixed(4)),
      expectedProfitAtRedemption: Number(profitAtRedemption.toFixed(4)),
      expectedRoiPct: Number((roi * 100).toFixed(3)),
      finishedAt: event.finishedTimestamp ?? result.finished_timestamp ?? null,
      detectedAt: new Date().toISOString(),
    }));
  }
  return "trade";
}

async function monitorFinal(result: SportResult): Promise<void> {
  if (running.has(result.slug)) return;
  running.add(result.slug);
  await new Promise((resolve) => setTimeout(resolve, CONFIRM_DELAY_MS));

  try {
    for (let attempt = 1; attempt <= MAX_RECHECKS; attempt++) {
      try {
        const decision = await evaluate(result);
        if (decision !== "retry") return;
      } catch (error) {
        console.warn(`[RETRY] ${result.slug}: ${(error as Error).message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, RECHECK_MS));
    }
    console.log(`[EXPIRE] ${result.slug}: no executable resolution-lag entry`);
  } finally {
    running.delete(result.slug);
  }
}

function connect(): void {
  console.log(`sports resolution-lag scanner: budget=$${CASH_BUDGET}, allIn=${MIN_ALL_IN}-${MAX_ALL_IN}, minROI=${(MIN_ROI * 100).toFixed(1)}%`);
  const ws = new WebSocket(SPORTS_WS);

  ws.on("open", () => console.log(`connected ${SPORTS_WS}`));
  ws.on("message", (raw) => {
    const text = raw.toString();
    if (text === "ping") {
      ws.send("pong");
      return;
    }
    try {
      const result = JSON.parse(text) as SportResult;
      if (result.slug && isTerminal(result)) void monitorFinal(result);
    } catch {
      // Ignore malformed/non-result frames.
    }
  });
  ws.on("error", (error) => console.error(`sports websocket: ${error.message}`));
  ws.on("close", () => setTimeout(connect, 2_000));
}

connect();

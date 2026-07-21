import type { GammaMarket } from "../adapters/polymarket.js";

export interface CalendarPair {
  early: GammaMarket;
  late: GammaMarket;
  key: string;
}

const MONTH = "(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)";
const DATE = `(?:${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+20\\d{2})?|${MONTH}\\s+20\\d{2}|20\\d{2}-\\d{1,2}-\\d{1,2}|\\d{1,2}\\/\\d{1,2}\\/20\\d{2}|(?:q[1-4]|first quarter|second quarter|third quarter|fourth quarter)\\s+20\\d{2}|(?:the\\s+)?end\\s+of\\s+${MONTH}(?:\\s+20\\d{2})?|(?:the\\s+)?end\\s+of\\s+20\\d{2})`;
const DEADLINE_RE = new RegExp(`\\b(by|before|on or before|through|until)\\s+${DATE}`, "gi");

export function normalizeCalendarQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(DEADLINE_RE, (_match, marker: string) => `${marker.toLowerCase()} <deadline>`)
    .replace(/[“”'"?,.:;!()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function binaryYesNo(market: GammaMarket): boolean {
  if (market.outcomes.length !== 2 || market.clobTokenIds.length !== 2) return false;
  const outcomes = market.outcomes.map((value) => value.toLowerCase());
  return outcomes.includes("yes") && outcomes.includes("no");
}

function normalizedSource(source: string): string {
  return source.toLowerCase().replace(/\s+/g, " ").trim();
}

function sameResolutionTerms(a: GammaMarket, b: GammaMarket): boolean {
  if (!a.resolutionSource || !b.resolutionSource || !a.description || !b.description) return false;
  if (normalizedSource(a.resolutionSource) !== normalizedSource(b.resolutionSource)) return false;
  return normalizeCalendarQuestion(a.description) === normalizeCalendarQuestion(b.description);
}

export function findCalendarPairs(markets: GammaMarket[], now = Date.now()): CalendarPair[] {
  const groups = new Map<string, GammaMarket[]>();
  for (const market of markets) {
    if (!market.question || !market.endDate || !market.acceptingOrders || market.closed || !binaryYesNo(market)) continue;
    const key = normalizeCalendarQuestion(market.question);
    if (!key.includes("<deadline>")) continue;
    const endMs = new Date(market.endDate).getTime();
    if (!Number.isFinite(endMs) || endMs <= now) continue;
    const group = groups.get(key) ?? [];
    group.push(market);
    groups.set(key, group);
  }

  const pairs: CalendarPair[] = [];
  for (const [normalized, group] of groups) {
    group.sort((a, b) => new Date(a.endDate!).getTime() - new Date(b.endDate!).getTime());
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const early = group[i];
        const late = group[j];
        if (!sameResolutionTerms(early, late)) continue;
        const gapDays = (new Date(late.endDate!).getTime() - new Date(early.endDate!).getTime()) / 86_400_000;
        if (gapDays < 1 || gapDays > 60) continue;
        pairs.push({ early, late, key: `${normalized}:${early.id}:${late.id}` });
      }
    }
  }
  return pairs;
}

export function outcomeToken(market: GammaMarket, outcome: "Yes" | "No"): string | null {
  const index = market.outcomes.findIndex((value) => value.toLowerCase() === outcome.toLowerCase());
  return index >= 0 ? market.clobTokenIds[index] ?? null : null;
}

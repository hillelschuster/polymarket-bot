import type { GammaMarket } from "../adapters/polymarket.js";

export interface CalendarPair {
  early: GammaMarket;
  late: GammaMarket;
  key: string;
}

const MONTH = "(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)";
const DATE = `(?:${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+20\\d{2})?|${MONTH}\\s+20\\d{2}|20\\d{2}-\\d{1,2}-\\d{1,2}|\\d{1,2}\\/\\d{1,2}\\/20\\d{2}|(?:q[1-4]|first quarter|second quarter|third quarter|fourth quarter)\\s+20\\d{2}|(?:the\\s+)?end\\s+of\\s+${MONTH}(?:\\s+20\\d{2})?|(?:the\\s+)?end\\s+of\\s+20\\d{2})`;
const DEADLINE_RE = new RegExp(`\\b(by|before|on or before|through|until)\\s+${DATE}`, "gi");

/** Replace only deadline dates. "In 2026" is deliberately not treated as monotonic. */
export function normalizeCalendarQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(DEADLINE_RE, (_match, marker: string) => `${marker.toLowerCase()} <deadline>`)
    .replace(/[“”'"?,.:;!()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isBinaryYesNo(m: GammaMarket): boolean {
  if (m.outcomes.length !== 2 || m.clobTokenIds.length !== 2) return false;
  const outcomes = m.outcomes.map((x) => x.toLowerCase());
  return outcomes.includes("yes") && outcomes.includes("no");
}

function sameResolutionTerms(a: GammaMarket, b: GammaMarket): boolean {
  if (!a.resolutionSource || !b.resolutionSource) return false;
  if (a.resolutionSource.trim() !== b.resolutionSource.trim()) return false;
  if (a.eventId && b.eventId && a.eventId !== b.eventId) return false;
  if (a.description && b.description) {
    const ad = normalizeCalendarQuestion(a.description);
    const bd = normalizeCalendarQuestion(b.description);
    if (ad !== bd) return false;
  }
  return true;
}

export function findCalendarPairs(markets: GammaMarket[], now = Date.now()): CalendarPair[] {
  const groups = new Map<string, GammaMarket[]>();
  for (const m of markets) {
    if (!m.question || !m.endDate || !m.acceptingOrders || m.closed || !isBinaryYesNo(m)) continue;
    const key = normalizeCalendarQuestion(m.question);
    if (!key.includes("<deadline>")) continue;
    const endMs = new Date(m.endDate).getTime();
    if (!Number.isFinite(endMs) || endMs <= now) continue;
    const arr = groups.get(key) ?? [];
    arr.push(m);
    groups.set(key, arr);
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
  const idx = market.outcomes.findIndex((x) => x.toLowerCase() === outcome.toLowerCase());
  return idx >= 0 ? market.clobTokenIds[idx] ?? null : null;
}

import type { GammaMarket } from "../adapters/polymarket.js";

export interface CalendarPair {
  early: GammaMarket;
  late: GammaMarket;
  key: string;
}

const MONTH = "(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)";
const DATE = `(?:${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+20\\d{2})?|${MONTH}\\s+20\\d{2}|20\\d{2}-\\d{1,2}-\\d{1,2}|\\d{1,2}\\/\\d{1,2}\\/20\\d{2}|(?:q[1-4]|first quarter|second quarter|third quarter|fourth quarter)\\s+20\\d{2}|(?:the\\s+)?end\\s+of\\s+${MONTH}(?:\\s+20\\d{2})?|(?:the\\s+)?end\\s+of\\s+20\\d{2})`;
const DEADLINE_RE = new RegExp(`\\b(by|before|on or before|through|until)\\s+${DATE}`, "gi");
const DEADLINE_CAPTURE_RE = new RegExp(`\\b(?:by|before|on or before|through|until)\\s+(${DATE})`, "i");

const MONTH_INDEX: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

export function normalizeCalendarQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(DEADLINE_RE, (_match, marker: string) => `${marker.toLowerCase()} <deadline>`)
    .replace(/[“”'"?,.:;!()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function utcEndOfDay(year: number, month: number, day: number): number {
  return Date.UTC(year, month, day, 23, 59, 59, 999);
}

function closestYearDate(month: number, day: number, referenceMs: number): number {
  const referenceYear = new Date(referenceMs).getUTCFullYear();
  return [referenceYear - 1, referenceYear, referenceYear + 1]
    .map((year) => utcEndOfDay(year, month, day))
    .sort((a, b) => Math.abs(a - referenceMs) - Math.abs(b - referenceMs))[0];
}

export function calendarDeadlineMs(market: GammaMarket): number | null {
  if (!market.question) return null;
  const captured = market.question.toLowerCase().match(DEADLINE_CAPTURE_RE)?.[1]
    ?.replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!captured) return null;
  const referenceMs = market.endDate ? new Date(market.endDate).getTime() : Date.now();
  if (!Number.isFinite(referenceMs)) return null;

  let match = captured.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/);
  if (match) return utcEndOfDay(Number(match[1]), Number(match[2]) - 1, Number(match[3]));

  match = captured.match(/^(\d{1,2})\/(\d{1,2})\/(20\d{2})$/);
  if (match) return utcEndOfDay(Number(match[3]), Number(match[1]) - 1, Number(match[2]));

  match = captured.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(20\d{2}))?$/);
  if (match && match[1] in MONTH_INDEX) {
    const month = MONTH_INDEX[match[1]];
    const day = Number(match[2]);
    return match[3]
      ? utcEndOfDay(Number(match[3]), month, day)
      : closestYearDate(month, day, referenceMs);
  }

  match = captured.match(/^(?:the\s+)?end\s+of\s+([a-z]+)(?:\s+(20\d{2}))?$/);
  if (match && match[1] in MONTH_INDEX) {
    const month = MONTH_INDEX[match[1]];
    const year = match[2] ? Number(match[2]) : new Date(referenceMs).getUTCFullYear();
    return utcEndOfDay(year, month + 1, 0);
  }

  match = captured.match(/^([a-z]+)\s+(20\d{2})$/);
  if (match && match[1] in MONTH_INDEX) {
    return utcEndOfDay(Number(match[2]), MONTH_INDEX[match[1]] + 1, 0);
  }

  match = captured.match(/^(q[1-4]|first quarter|second quarter|third quarter|fourth quarter)\s+(20\d{2})$/);
  if (match) {
    const quarter = match[1].startsWith("q")
      ? Number(match[1][1])
      : ["first quarter", "second quarter", "third quarter", "fourth quarter"].indexOf(match[1]) + 1;
    return utcEndOfDay(Number(match[2]), quarter * 3, 0);
  }

  match = captured.match(/^(?:the\s+)?end\s+of\s+(20\d{2})$/);
  if (match) return utcEndOfDay(Number(match[1]), 11, 31);
  return null;
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
    const deadline = calendarDeadlineMs(market);
    if (deadline == null || deadline <= now) continue;
    const key = normalizeCalendarQuestion(market.question);
    if (!key.includes("<deadline>")) continue;
    const group = groups.get(key) ?? [];
    group.push(market);
    groups.set(key, group);
  }

  const pairs: CalendarPair[] = [];
  for (const [normalized, group] of groups) {
    group.sort((a, b) => calendarDeadlineMs(a)! - calendarDeadlineMs(b)!);
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const early = group[i];
        const late = group[j];
        if (!sameResolutionTerms(early, late)) continue;
        const gapDays = (calendarDeadlineMs(late)! - calendarDeadlineMs(early)!) / 86_400_000;
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

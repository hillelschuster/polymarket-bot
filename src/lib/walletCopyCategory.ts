const SPORTS_PREFIXES = [
  "mlb", "nba", "nfl", "nhl", "wnba", "ncaaf", "ncaab", "cfb", "cbb",
  "epl", "ucl", "uel", "mls", "mex", "liga-mx", "la-liga", "serie-a",
  "bundesliga", "ligue-1", "eredivisie", "primeira-liga", "fifa", "fifwc",
  "atp", "wta", "itf", "challenger", "tennis", "golf", "ufc", "boxing",
  "f1", "nascar", "cricket", "ipl",
];
const SPORTS_LABELS = new Set([
  "sports", "sport", "baseball", "basketball", "football", "soccer", "hockey",
  "tennis", "golf", "mma", "boxing", "motorsport", "cricket",
]);
const ESPORTS_PREFIXES = ["cs2", "csgo", "lol", "dota2", "valorant", "val", "overwatch", "rl"];
const ESPORTS_LABELS = new Set(["esports", "e-sports", "gaming"]);
const CRYPTO_PREFIXES = ["crypto", "btc", "eth", "sol", "xrp"];
const CRYPTO_LABELS = new Set(["crypto", "cryptocurrency"]);
const POLITICS_PREFIXES = ["politics", "political", "election", "president"];
const POLITICS_LABELS = new Set(["politics", "political", "elections", "election"]);

function hasPrefix(slug: string, prefixes: string[]): boolean {
  const normalized = slug.toLowerCase();
  return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}-`));
}

export function walletCopyCategory(slug?: string | null, explicit?: string | null): string | null {
  const label = explicit?.trim().toLowerCase();
  if (label) {
    if (SPORTS_LABELS.has(label)) return "sports";
    if (ESPORTS_LABELS.has(label)) return "esports";
    if (CRYPTO_LABELS.has(label)) return "crypto";
    if (POLITICS_LABELS.has(label)) return "politics";
  }
  if (slug) {
    if (hasPrefix(slug, SPORTS_PREFIXES)) return "sports";
    if (hasPrefix(slug, ESPORTS_PREFIXES)) return "esports";
    if (hasPrefix(slug, CRYPTO_PREFIXES)) return "crypto";
    if (hasPrefix(slug, POLITICS_PREFIXES)) return "politics";
  }
  return label ?? null;
}

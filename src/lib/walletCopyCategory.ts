const SPORTS_PREFIXES = [
  "mlb", "nba", "nfl", "nhl", "wnba", "ncaaf", "ncaab", "cfb", "cbb",
  "epl", "ucl", "uel", "mls", "mex", "liga-mx", "la-liga", "serie-a",
  "bundesliga", "ligue-1", "eredivisie", "primeira-liga", "fifa", "fifwc",
  "atp", "wta", "itf", "challenger", "tennis", "golf", "ufc", "boxing",
  "f1", "nascar", "cricket", "ipl",
];
const ESPORTS_PREFIXES = ["cs2", "csgo", "lol", "dota2", "valorant", "val", "overwatch", "rl"];
const CRYPTO_PREFIXES = ["crypto", "btc", "eth", "sol", "xrp"];
const POLITICS_PREFIXES = ["politics", "political", "election", "president"];

function hasPrefix(slug: string, prefixes: string[]): boolean {
  const normalized = slug.toLowerCase();
  return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}-`));
}

export function walletCopyCategory(slug?: string | null, explicit?: string | null): string | null {
  if (explicit) return explicit.toLowerCase();
  if (!slug) return null;
  if (hasPrefix(slug, SPORTS_PREFIXES)) return "sports";
  if (hasPrefix(slug, ESPORTS_PREFIXES)) return "esports";
  if (hasPrefix(slug, CRYPTO_PREFIXES)) return "crypto";
  if (hasPrefix(slug, POLITICS_PREFIXES)) return "politics";
  return null;
}

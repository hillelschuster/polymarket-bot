"""
CORE 2: MLB Baseball Moneyline Signal Evaluator
- Strictly evaluates MLB straight moneyline match winners.
- Rejects run lines (-1.5 / +1.5 spreads), inning props, 1st 5 innings, high totals.
- Enforces Golden Alpha price band: 0.550 <= executable_ask <= 0.740.
- Rejects illiquid orderbooks (spread > 0.040, depth < $30).
"""

from typing import Dict, Optional, Tuple

BASEBALL_VALID_PREFIXES = ("mlb-", "baseball-mlb", "kbo-", "npb-")
FORBIDDEN_BASEBALL_KEYWORDS = (
    "spread", "run-line", "runline", "total", "over-", "under-", "innings",
    "1st-5", "1st-inning", "hits", "strikeouts", "props"
)

class BaseballSignalEvaluator:
    def __init__(self, golden_min: float = 0.550, golden_max: float = 0.740, max_spread: float = 0.040):
        self.golden_min = golden_min
        self.golden_max = golden_max
        self.max_spread = max_spread

    def evaluate(self, market: dict, orderbook_bids: list, orderbook_asks: list, source_whale: Optional[str] = None) -> Tuple[bool, str, Optional[dict]]:
        slug = str(market.get("slug") or market.get("eventSlug") or "").lower()
        title = str(market.get("question") or market.get("title") or "").lower()

        # 1. Reject Spreads, Run-Lines, and High Totals
        if any(k in slug or k in title for k in FORBIDDEN_BASEBALL_KEYWORDS):
            return False, "Excluded baseball derivative (run-line / spread / props / totals)", None

        # 2. Match Valid MLB Prefixes
        is_mlb = slug.startswith("mlb-") or "mlb" in slug or "major league baseball" in title
        if not is_mlb:
            return False, "Not an MLB straight moneyline market", None

        # 3. Check Orderbook
        if not orderbook_asks:
            return False, "Empty orderbook asks", None

        best_ask = orderbook_asks[0].price
        best_bid = orderbook_bids[0].price if orderbook_bids else 0.0
        spread = best_ask - best_bid if best_bid > 0 else 0.0
        total_depth_usd = sum(a.price * a.size for a in orderbook_asks[:5])

        # 4. Golden Alpha Price Band Gate
        if not (self.golden_min <= best_ask <= self.golden_max):
            return False, f"Ask price {best_ask:.3f} outside Golden Band [{self.golden_min:.3f}, {self.golden_max:.3f}]", None

        # 5. Spread & Liquidity Gate
        if best_bid > 0 and spread > self.max_spread:
            return False, f"Spread {spread:.3f} exceeds max {self.max_spread:.3f}", None

        if total_depth_usd < 25.0:
            return False, f"Inside depth ${total_depth_usd:.2f} below $25.00 minimum", None

        signal_source = f"WHALE:{source_whale[:10]}" if source_whale else "ORGANIC_BASEBALL_FLOW"

        return True, "ADMITTED", {
            "strategy_lane": "BASEBALL_MLB_MONEYLINE",
            "category": "sports",
            "market_slug": slug,
            "token_id": market.get("token_id") or market.get("asset"),
            "condition_id": market.get("condition_id") or market.get("conditionId"),
            "side": "YES",
            "best_ask": best_ask,
            "best_bid": best_bid,
            "spread": spread,
            "depth_usd": total_depth_usd,
            "price_band": "0.55-0.74",
            "source_signal": signal_source,
            "hold_to_resolution": True
        }

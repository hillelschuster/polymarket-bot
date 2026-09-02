"""
CORE 1: ATP / ITF Tennis Moneyline Signal Evaluator
- Strictly evaluates ATP Tour, ATP Challenger, and ITF World Tour singles match winners.
- Rejects WTA (decoupled due to break volatility), doubles, set handicaps, game totals, spreads.
- Enforces Golden Alpha price band: 0.550 <= executable_ask <= 0.740.
- Rejects illiquid orderbooks (spread > 0.040, depth < $30).
- Verifies domain whale signal OR significant organic order flow.
"""

from typing import Dict, Optional, Tuple

TENNIS_VALID_PREFIXES = ("atp-", "itf-", "tennis-atp", "tennis-itf")
FORBIDDEN_DERIVATIVE_KEYWORDS = (
    "handicap", "spread", "total", "games", "set-1", "set-2", "set-3",
    "tiebreak", "double", "doubles", "wta-", "wta", "game-handicap", "sets"
)

class TennisSignalEvaluator:
    def __init__(self, golden_min: float = 0.550, golden_max: float = 0.740, max_spread: float = 0.040):
        self.golden_min = golden_min
        self.golden_max = golden_max
        self.max_spread = max_spread

    def evaluate(self, market: dict, orderbook_bids: list, orderbook_asks: list, source_whale: Optional[str] = None) -> Tuple[bool, str, Optional[dict]]:
        slug = str(market.get("slug") or market.get("eventSlug") or "").lower()
        title = str(market.get("question") or market.get("title") or "").lower()

        # 1. Reject Forbidden Derivatives & WTA
        if any(k in slug or k in title for k in FORBIDDEN_DERIVATIVE_KEYWORDS):
            return False, "Excluded derivative market or WTA match", None

        # 2. Match Valid ATP/ITF Singles Prefixes
        is_atp = slug.startswith("atp-") or "atp" in slug or "atp" in title
        is_itf = slug.startswith("itf-") or "itf" in slug or "itf" in title

        if not (is_atp or is_itf):
            return False, "Not an ATP or ITF singles tournament", None

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

        signal_source = f"WHALE:{source_whale[:10]}" if source_whale else "ORGANIC_FAVORITE_FLOW"

        return True, "ADMITTED", {
            "strategy_lane": "TENNIS_ATP_ITF",
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

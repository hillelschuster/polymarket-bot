"""
SATELLITE 1: Soccer 2-Way Low-Threshold Derivatives & Fading Favorites Evaluator
- Strictly evaluates 2-Way binary soccer markets: Over 1.5, Over 2.5, BTTS YES, +1.5 Spreads, Draw-No-Bet.
- Permitted 3-Way Strategy: Fading favorites (buying NO).
- Strictly rejects Backing 3-Way 1X2 Favorites (buying YES) and Over 3.5 totals.
"""

from typing import Dict, Optional, Tuple

SOCCER_VALID_PREFIXES = ("epl-", "ucl-", "fl1-", "sea-", "itsb-", "ere-", "mex-", "chi-", "mls-", "laliga-", "bund-", "uel-")

class SoccerSignalEvaluator:
    def __init__(self, golden_min: float = 0.550, golden_max: float = 0.720, max_spread: float = 0.040):
        self.golden_min = golden_min
        self.golden_max = golden_max
        self.max_spread = max_spread

    def evaluate(self, market: dict, orderbook_bids: list, orderbook_asks: list, source_whale: Optional[str] = None) -> Tuple[bool, str, Optional[dict]]:
        slug = str(market.get("slug") or market.get("eventSlug") or "").lower()
        title = str(market.get("question") or market.get("title") or "").lower()

        # 1. Hard Reject Over 3.5 and High Tail Totals
        if "total-3pt5" in slug or "total-4pt5" in slug or "over 3.5" in title:
            return False, "Excluded high tail total (Over 3.5)", None

        # 2. Check for 2-Way Derivatives
        is_2way_low_total = "total-1pt5" in slug or "total-2pt5" in slug or "over 1.5" in title or "over 2.5" in title
        is_btts = "btts" in slug or "both teams to score" in title
        is_spread_plus = "+1.5" in title or "spread-away-1pt5" in slug or "spread-home-1pt5" in slug

        # 3. Check for Fading 3-Way Favorite (Buying NO)
        outcome_str = str(market.get("outcome") or "").upper()
        is_fading_favorite_no = (outcome_str == "NO" or "no" in slug) and any(slug.startswith(p) for p in SOCCER_VALID_PREFIXES)

        if not (is_2way_low_total or is_btts or is_spread_plus or is_fading_favorite_no):
            return False, "Excluded 3-way moneyline backing favorite (Draw risk trap)", None

        # 4. Check Orderbook
        if not orderbook_asks:
            return False, "Empty orderbook asks", None

        best_ask = orderbook_asks[0].price
        best_bid = orderbook_bids[0].price if orderbook_bids else 0.0
        spread = best_ask - best_bid if best_bid > 0 else 0.0
        total_depth_usd = sum(a.price * a.size for a in orderbook_asks[:5])

        if not (self.golden_min <= best_ask <= self.golden_max):
            return False, f"Ask price {best_ask:.3f} outside band [{self.golden_min:.3f}, {self.golden_max:.3f}]", None

        if best_bid > 0 and spread > self.max_spread:
            return False, f"Spread {spread:.3f} exceeds max {self.max_spread:.3f}", None

        signal_source = f"WHALE:{source_whale[:10]}" if source_whale else "SOCCER_2WAY_FLOW"

        return True, "ADMITTED", {
            "strategy_lane": "SOCCER_2WAY_DERIVATIVES",
            "category": "sports",
            "market_slug": slug,
            "token_id": market.get("token_id") or market.get("asset"),
            "condition_id": market.get("condition_id") or market.get("conditionId"),
            "side": "YES" if not is_fading_favorite_no else "NO",
            "best_ask": best_ask,
            "best_bid": best_bid,
            "spread": spread,
            "depth_usd": total_depth_usd,
            "price_band": "0.55-0.72",
            "source_signal": signal_source,
            "hold_to_resolution": True
        }

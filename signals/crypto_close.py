"""
SATELLITE 2: Crypto Hourly Late-Close & TWAP Variance Evaluator
- Evaluates BTC & ETH hourly open-vs-close contracts in the final 20 seconds.
- Uses discrete variance collapse math to confirm theoretical fair probability >= 98.5% (Z >= 2.17).
"""

import math
from typing import Dict, Optional, Tuple

class CryptoCloseSignalEvaluator:
    def __init__(self, window: float = 30.0, sigma_sec: float = 0.00035):
        self.window = window
        self.sigma_sec = sigma_sec

    def evaluate(
        self,
        market: dict,
        spot_price: float,
        strike_price: float,
        seconds_remaining: float,
        orderbook_bids: list,
        orderbook_asks: list
    ) -> Tuple[bool, str, Optional[dict]]:
        slug = str(market.get("slug") or "").lower()

        # 1. Timing Gate: Strictly 2.0s <= t <= 18.0s
        if not (2.0 <= seconds_remaining <= 18.0):
            return False, f"Seconds remaining ({seconds_remaining:.1f}s) outside sniper window [2.0s, 18.0s]", None

        # 2. Discrete TWAP Variance Calculation
        discrete_factor = (seconds_remaining * (seconds_remaining + 1.0) * (2.0 * seconds_remaining + 1.0)) / (6.0 * (self.window ** 2))
        sigma_eff = math.sqrt((self.sigma_sec ** 2) * discrete_factor * (spot_price ** 2))

        if sigma_eff <= 1e-6:
            return False, "Sigma effective is zero", None

        z_score = abs(spot_price - strike_price) / sigma_eff
        if z_score < 2.17:  # P(fair) < 98.5%
            return False, f"Z-score {z_score:.2f} below required 2.17 (P < 98.5%)", None

        if not orderbook_asks:
            return False, "Empty orderbook asks", None

        best_ask = orderbook_asks[0].price
        best_bid = orderbook_bids[0].price if orderbook_bids else 0.0
        spread = best_ask - best_bid if best_bid > 0 else 0.0

        if not (0.550 <= best_ask <= 0.740):
            return False, f"Ask price {best_ask:.3f} outside band [0.550, 0.740]", None

        target_side = "YES" if spot_price > strike_price else "NO"

        return True, "ADMITTED", {
            "strategy_lane": "CRYPTO_HOURLY_LATE_CLOSE",
            "category": "crypto",
            "market_slug": slug,
            "token_id": market.get("token_id") or market.get("asset"),
            "condition_id": market.get("condition_id") or market.get("conditionId"),
            "side": target_side,
            "best_ask": best_ask,
            "best_bid": best_bid,
            "spread": spread,
            "depth_usd": sum(a.price * a.size for a in orderbook_asks[:3]),
            "price_band": "0.55-0.74",
            "source_signal": f"TWAP_VARIANCE_Z_{z_score:.1f}",
            "hold_to_resolution": True
        }

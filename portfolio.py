"""
Portfolio & Capital Allocation Manager for Polymarket Enhanced Engine
Enforces bankroll risk limits, daily loss circuit breakers, and calibrated sizing.
"""

import time
import logging
from typing import Optional, Tuple
from config import EnhancedConfig, load_config
from db import EnhancedDB

logger = logging.getLogger("EnhancedBot.Portfolio")

class PortfolioManager:
    def __init__(self, config: Optional[EnhancedConfig] = None, db: Optional[EnhancedDB] = None):
        self.config = config or load_config()
        self.db = db or EnhancedDB(self.config.db_path)

    def can_open_position(self, strategy_lane: str) -> Tuple[bool, str, float]:
        """
        Evaluates portfolio limits before submitting a trade.
        Returns: (can_trade, reason, recommended_budget_usd)
        """
        summary = self.db.get_portfolio_summary()
        pos_info = summary.get("positions", {})
        
        open_count = pos_info.get("open_count") or 0
        open_exposure = pos_info.get("open_exposure") or 0.0

        # 1. Check Max Open Positions Gate
        if open_count >= self.config.max_open_positions:
            return False, f"Max open positions reached ({open_count}/{self.config.max_open_positions})", 0.0

        # 2. Check Bankroll Exposure Gate (Max 75% allocated)
        max_allowable_exposure = self.config.bankroll_usd * 0.75
        if open_exposure >= max_allowable_exposure:
            return False, f"Portfolio exposure ${open_exposure:.2f} exceeds limit ${max_allowable_exposure:.2f}", 0.0

        # 3. Check Daily Loss Circuit Breaker via clean DB helper
        pnl_24h = self.db.get_24h_realized_pnl()
        if pnl_24h <= -self.config.daily_max_loss_usd:
            return False, f"Daily circuit breaker active! (24h Realized PnL: ${pnl_24h:+.2f} <= -${self.config.daily_max_loss_usd:.2f})", 0.0

        # 4. Calibrated Sizing Allocation
        if strategy_lane == "TENNIS_ATP_ITF":
            budget = self.config.sizing_tennis_atp_itf_usd
        elif strategy_lane == "BASEBALL_MLB_MONEYLINE":
            budget = self.config.sizing_baseball_mlb_usd
        elif strategy_lane == "SOCCER_2WAY_DERIVATIVES":
            budget = self.config.sizing_soccer_2way_usd
        elif strategy_lane == "CRYPTO_HOURLY_LATE_CLOSE":
            budget = self.config.sizing_crypto_close_usd
        else:
            budget = 25.00

        # Ensure budget does not exceed remaining free capacity
        remaining_capacity = max_allowable_exposure - open_exposure
        final_budget = min(budget, remaining_capacity)

        if final_budget < self.config.min_order_notional_usd:
            return False, f"Calculated budget ${final_budget:.2f} below min ${self.config.min_order_notional_usd:.2f}", 0.0

        return True, "OK", round(final_budget, 2)

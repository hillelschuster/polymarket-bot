"""
Unit Tests for Polymarket Enhanced Engine
Protects the critical money path: classification, admission, dynamic fees, L2 walking, and sizing.
"""

import unittest
import os
import sys

# Ensure parent directory is in sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from config import load_config
from db import EnhancedDB
from execution import ExecutionEngine, OrderLevel
from signals.tennis import TennisSignalEvaluator
from signals.baseball import BaseballSignalEvaluator
from signals.soccer import SoccerSignalEvaluator
from portfolio import PortfolioManager

class TestPolymarketEnhanced(unittest.TestCase):
    def setUp(self):
        self.config = load_config()
        self.config.db_path = ":memory:"
        self.db = EnhancedDB(self.config.db_path)
        self.exec_engine = ExecutionEngine(self.config, self.db)
        self.portfolio = PortfolioManager(self.config, self.db)
        self.tennis_eval = TennisSignalEvaluator()
        self.baseball_eval = BaseballSignalEvaluator()
        self.soccer_eval = SoccerSignalEvaluator()

    def test_dynamic_fee_calculation(self):
        # Sports: 5% * p * (1 - p)
        fee_sports_65 = self.exec_engine.calculate_dynamic_fee(0.65, category="sports")
        self.assertAlmostEqual(fee_sports_65, 0.05 * 0.65 * 0.35, places=5)

        # Crypto: 7% * p * (1 - p)
        fee_crypto_65 = self.exec_engine.calculate_dynamic_fee(0.65, category="crypto")
        self.assertAlmostEqual(fee_crypto_65, 0.07 * 0.65 * 0.35, places=5)

        # Maker: 0.0%
        fee_maker = self.exec_engine.calculate_dynamic_fee(0.65, is_maker=True)
        self.assertEqual(fee_maker, 0.0)

    def test_tennis_signal_admission(self):
        bids = [OrderLevel(price=0.62, size=100.0)]
        asks = [OrderLevel(price=0.64, size=100.0)]

        # Valid ATP Singles Match
        valid_market = {"slug": "atp-alcaraz-sinner-2026-09-01", "question": "Alcaraz vs Sinner", "token_id": "tok123", "condition_id": "c123"}
        admitted, reason, data = self.tennis_eval.evaluate(valid_market, bids, asks)
        self.assertTrue(admitted)
        self.assertEqual(data["strategy_lane"], "TENNIS_ATP_ITF")

        # Excluded Spread
        spread_market = {"slug": "atp-alcaraz-sinner-set-handicap-1pt5", "question": "Set Handicap", "token_id": "tok123"}
        admitted, reason, data = self.tennis_eval.evaluate(spread_market, bids, asks)
        self.assertFalse(admitted)

        # Excluded WTA
        wta_market = {"slug": "wta-swiatek-sabalenka-2026-09-01", "question": "Swiatek vs Sabalenka", "token_id": "tok123"}
        admitted, reason, data = self.tennis_eval.evaluate(wta_market, bids, asks)
        self.assertFalse(admitted)

        # Out of price band (Ask = 0.82)
        high_asks = [OrderLevel(price=0.82, size=100.0)]
        admitted, reason, data = self.tennis_eval.evaluate(valid_market, bids, high_asks)
        self.assertFalse(admitted)

    def test_baseball_signal_admission(self):
        bids = [OrderLevel(price=0.67, size=100.0)]
        asks = [OrderLevel(price=0.69, size=100.0)]

        # Valid MLB Moneyline
        valid_mlb = {"slug": "mlb-nyy-bos-2026-09-01", "question": "Yankees vs Red Sox", "token_id": "tok_mlb", "condition_id": "c_mlb"}
        admitted, reason, data = self.baseball_eval.evaluate(valid_mlb, bids, asks)
        self.assertTrue(admitted)
        self.assertEqual(data["strategy_lane"], "BASEBALL_MLB_MONEYLINE")

        # Excluded Run Line / Spread
        runline_mlb = {"slug": "mlb-nyy-bos-spread-home-1pt5", "question": "Run Line", "token_id": "tok_mlb"}
        admitted, reason, data = self.baseball_eval.evaluate(runline_mlb, bids, asks)
        self.assertFalse(admitted)

    def test_l2_depth_walking(self):
        asks = [
            OrderLevel(price=0.60, size=50.0),
            OrderLevel(price=0.62, size=50.0),
            OrderLevel(price=0.65, size=50.0)
        ]
        success, shares, cash_used, vwap, msg = self.exec_engine.walk_l2_book_for_cash_buy(
            asks, cash_budget_usd=40.0, depth_haircut=0.30, slippage_buffer=0.005, max_acceptable_price=0.74
        )
        self.assertTrue(success)
        self.assertGreater(shares, 0.0)
        self.assertLessEqual(cash_used, 40.0)
        self.assertGreaterEqual(vwap, 0.60)

    def test_portfolio_limits(self):
        can_trade, reason, budget = self.portfolio.can_open_position("TENNIS_ATP_ITF")
        self.assertTrue(can_trade)
        self.assertEqual(budget, 40.0)

    def test_whale_cooldown_filter(self):
        whale = "0x1610db79f753a80207e1d66716be9e91e627ae49"
        # 1. No loss recorded yet -> not on cooldown
        on_cd, reason = self.db.is_whale_on_cooldown(whale, cooldown_hours=24.0)
        self.assertFalse(on_cd)

        # 2. Simulate a resolved loss for this whale
        import time
        loss_pos = {
            "position_id": "test_loss_1",
            "strategy_lane": "TENNIS_ATP_ITF",
            "token_id": "tok_loss",
            "market_slug": "atp-test-match-loss",
            "category": "sports",
            "side": "YES",
            "trading_mode": "PAPER",
            "entry_timestamp": time.time() - 3600,
            "shares": 50.0,
            "cash_invested_usd": 40.0,
            "entry_vwap": 0.65,
            "entry_fee_usd": 0.70,
            "all_in_entry_price": 0.66,
            "current_price": 0.0,
            "realized_pnl_usd": -40.0,
            "status": "RESOLVED",
            "resolution_outcome": "LOSS",
            "closed_timestamp": time.time() - 1800,  # 30 mins ago
            "source_signal": f"WHALE:{whale[:10]}"
        }
        self.db.save_position(loss_pos)

        # 3. Now whale should be on cooldown
        on_cd, reason = self.db.is_whale_on_cooldown(whale, cooldown_hours=24.0)
        self.assertTrue(on_cd)
        self.assertIn("suffered loss", reason)

        # 4. If cooldown is 0.1 hours (6 mins), 30 mins ago is outside window
        on_cd_short, _ = self.db.is_whale_on_cooldown(whale, cooldown_hours=0.1)
        self.assertFalse(on_cd_short)

    def test_pruned_whale_whitelist(self):
        # Whitelist should contain the 5 Tier-1 sharps
        self.assertEqual(len(self.config.tracked_whale_wallets), 5)
        self.assertIn("0x1610db79f753a80207e1d66716be9e91e627ae49".lower(), self.config.tracked_whale_wallets)
        self.assertIn("0x6d3c5bd13984b2de47c3a88ddc455309aab3d294".lower(), self.config.tracked_whale_wallets)
        self.assertIn("0x4f29e103339919c4baaea2a731efc1b4737fa2ad".lower(), self.config.tracked_whale_wallets)
        self.assertIn("0x224a89dbe0db0d6124b335eb2ba1216d00472479".lower(), self.config.tracked_whale_wallets)
        self.assertIn("0x5268527977f700f9bf9b6d5cd843859e4e70135d".lower(), self.config.tracked_whale_wallets)

if __name__ == "__main__":
    unittest.main()

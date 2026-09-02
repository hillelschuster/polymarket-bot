"""
Market Scanner & Signal Dispatcher for Polymarket Enhanced (Pure Whale-Gated Engine)
Monitors real-time Polymarket trade feed for tracked sharp whale wallet transactions.
Enforces:
1. 100% Whale-Gated Entry: Never buys arbitrary matches without a sharp whale signal.
2. Strict Golden Band [0.550, 0.740] & Spread Checks (<= 0.040).
3. Date Guard: Rejects stale/historical matches.
4. Position Idempotency & Rate Limited HTTP.
"""

import time
import logging
import collections
import json
import re
import datetime
from typing import Dict, List, Optional
from config import EnhancedConfig, load_config
from db import EnhancedDB
from execution import ExecutionEngine
from portfolio import PortfolioManager
from http_client import global_http_session
from signals import (
    TennisSignalEvaluator,
    BaseballSignalEvaluator,
    SoccerSignalEvaluator,
    CryptoCloseSignalEvaluator
)

logger = logging.getLogger("EnhancedBot.Scanner")
DATA_API_TRADES_URL = "https://data-api.polymarket.com/trades"

class MarketScanner:
    def __init__(
        self,
        config: Optional[EnhancedConfig] = None,
        db: Optional[EnhancedDB] = None,
        exec_engine: Optional[ExecutionEngine] = None,
        portfolio: Optional[PortfolioManager] = None
    ):
        self.config = config or load_config()
        self.db = db or EnhancedDB(self.config.db_path)
        self.exec_engine = exec_engine or ExecutionEngine(self.config, self.db)
        self.portfolio = portfolio or PortfolioManager(self.config, self.db)

        # Evaluators
        self.tennis_eval = TennisSignalEvaluator(self.config.golden_min_price, self.config.golden_max_price, self.config.max_allowable_spread)
        self.baseball_eval = BaseballSignalEvaluator(self.config.golden_min_price, self.config.golden_max_price, self.config.max_allowable_spread)
        self.soccer_eval = SoccerSignalEvaluator(self.config.golden_min_price, 0.720, self.config.max_allowable_spread)
        self.crypto_eval = CryptoCloseSignalEvaluator()

        self.processed_txs: collections.OrderedDict = collections.OrderedDict()
        self.token_cooldowns: Dict[str, float] = {}

    def _is_target_domain(self, slug: str, title: str = "") -> bool:
        s = slug.lower()
        t = title.lower()
        is_tennis = s.startswith("atp-") or s.startswith("itf-") or "tennis" in s or "atp" in t or "itf" in t
        is_baseball = s.startswith("mlb-") or "baseball" in s or "mlb" in t
        is_soccer = any(s.startswith(p) for p in ("epl-", "ucl-", "fl1-", "sea-", "laliga-", "bund-", "uel-")) or "premier league" in t
        return is_tennis or is_baseball or is_soccer

    def _is_current_or_future_date(self, slug: str) -> bool:
        """Extracts date from slug (YYYY-MM-DD) and verifies it is not an old historical event."""
        m = re.search(r'(\d{4})-(\d{2})-(\d{2})', slug)
        if m:
            try:
                event_date = datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
                today = datetime.datetime.now(datetime.timezone.utc).date()
                if (today - event_date).days > 1:
                    return False
            except ValueError:
                pass
        return True

    def _has_existing_open_position(self, token_id: str, market_slug: str) -> bool:
        open_positions = self.db.get_open_positions()
        return any(p["token_id"] == token_id or p["market_slug"] == market_slug for p in open_positions)

    def poll_whale_trade_stream(self):
        """Monitors live Polymarket trade feed for tracked specialist whale entries."""
        try:
            url = f"{DATA_API_TRADES_URL}?limit=100"
            resp = global_http_session.get(url)
            if resp.status_code != 200:
                return

            trades = resp.json()
            if not isinstance(trades, list):
                return

            now = time.time()
            for t in trades:
                tx_id = str(t.get("transactionHash") or t.get("id") or "")
                if not tx_id or tx_id in self.processed_txs:
                    continue

                self.processed_txs[tx_id] = True
                if len(self.processed_txs) > 4000:
                    self.processed_txs.popitem(last=False)

                wallet = str(t.get("proxyWallet") or t.get("maker") or t.get("taker") or "").lower()
                token_id = str(t.get("asset") or t.get("tokenId") or "")
                slug = str(t.get("eventSlug") or t.get("slug") or t.get("title") or "").lower()
                title = str(t.get("title") or "")
                trade_side = str(t.get("side") or "BUY").upper()

                if not token_id or not slug or trade_side != "BUY":
                    continue

                # Date Guard & Domain Pre-Filter
                if not self._is_target_domain(slug, title) or not self._is_current_or_future_date(slug):
                    continue

                # STRICT REQUIREMENT: Wallet must be a verified tracked sharp specialist
                if wallet not in self.config.tracked_whale_wallets:
                    continue

                # WHALE COOLDOWN GATE: Check if this whale suffered a recent loss (24h tilt/slump shield)
                on_cooldown, cd_reason = self.db.is_whale_on_cooldown(wallet, self.config.whale_cooldown_hours)
                if on_cooldown:
                    logger.info(f"[WHALE COOLDOWN] {cd_reason} - skipping trade on {slug}")
                    continue

                # Evaluate candidate market
                market_dict = {
                    "slug": slug,
                    "token_id": token_id,
                    "condition_id": t.get("conditionId") or "",
                    "question": title or slug,
                    "outcome": t.get("outcome") or "YES"
                }

                self.evaluate_and_execute_market(market_dict, source_whale=wallet)

        except Exception as e:
            logger.debug(f"Error in whale stream poll: {e}")

    def scan_active_gamma_markets(self):
        """Deprecated: Blind organic Gamma scanning is disabled to preserve 100% sharp whale alignment."""
        pass

    def evaluate_and_execute_market(self, market: dict, source_whale: Optional[str] = None):
        slug = market["slug"]
        token_id = market["token_id"]
        now = time.time()

        # Whale Cooldown Check
        if source_whale:
            on_cooldown, cd_reason = self.db.is_whale_on_cooldown(source_whale, self.config.whale_cooldown_hours)
            if on_cooldown:
                logger.info(f"[WHALE COOLDOWN] {cd_reason} - skipping {slug}")
                return

        # Cooldown: 1 position per token per 30 minutes
        if token_id in self.token_cooldowns and (now - self.token_cooldowns[token_id]) < 1800.0:
            return

        # DB Open Position Check: Prevent duplicate positions on the same market
        if self._has_existing_open_position(token_id, slug):
            return

        # Fetch Order Book
        bids, asks = self.exec_engine.fetch_order_book(token_id)
        if not asks:
            return

        best_ask = asks[0].price
        best_bid = bids[0].price if bids else 0.0
        spread = best_ask - best_bid if best_bid > 0 else 0.0
        depth_usd = sum(a.price * a.size for a in asks[:5])

        # 1. Evaluate Tennis (Core 1)
        if slug.startswith("atp-") or slug.startswith("itf-") or "tennis" in slug:
            admitted, reason, signal_data = self.tennis_eval.evaluate(market, bids, asks, source_whale)
            self._handle_evaluation_result(market, bids, asks, admitted, reason, signal_data, "TENNIS_ATP_ITF", depth_usd)
            return

        # 2. Evaluate Baseball (Core 2)
        if slug.startswith("mlb-") or "baseball" in slug:
            admitted, reason, signal_data = self.baseball_eval.evaluate(market, bids, asks, source_whale)
            self._handle_evaluation_result(market, bids, asks, admitted, reason, signal_data, "BASEBALL_MLB_MONEYLINE", depth_usd)
            return

        # 3. Evaluate Soccer (Satellite 1)
        if any(slug.startswith(p) for p in ("epl-", "ucl-", "fl1-", "sea-", "laliga-", "bund-", "uel-")):
            admitted, reason, signal_data = self.soccer_eval.evaluate(market, bids, asks, source_whale)
            self._handle_evaluation_result(market, bids, asks, admitted, reason, signal_data, "SOCCER_2WAY_DERIVATIVES", depth_usd)
            return

    def _handle_evaluation_result(
        self,
        market: dict,
        bids: list,
        asks: list,
        admitted: bool,
        reason: str,
        signal_data: Optional[dict],
        strategy_lane: str,
        depth_usd: float
    ):
        best_ask = asks[0].price if asks else 0.0
        best_bid = bids[0].price if bids else 0.0
        spread = best_ask - best_bid if best_bid > 0 else 0.0
        token_id = market["token_id"]
        slug = market["slug"]

        # Log Opportunity into DB
        opp_data = {
            "opportunity_id": f"opp_{int(time.time()*1000)}_{token_id[:6]}",
            "timestamp": time.time(),
            "market_slug": slug,
            "token_id": token_id,
            "strategy_lane": strategy_lane,
            "best_bid": best_bid,
            "best_ask": best_ask,
            "spread": spread,
            "depth_usd": depth_usd,
            "price_band": "0.55-0.74",
            "source_signal": signal_data.get("source_signal", "WHALE_COPY") if signal_data else "NONE",
            "decision": "ADMITTED" if admitted else "REJECTED",
            "rejection_reason": "" if admitted else reason,
            "evaluated_json": signal_data or {"reason": reason}
        }
        self.db.log_opportunity(opp_data)

        if not admitted or not signal_data:
            return

        # Portfolio Risk Check
        can_trade, p_reason, budget = self.portfolio.can_open_position(strategy_lane)
        if not can_trade:
            logger.info(f"[{strategy_lane}] SIGNAL ADMITTED BUT BLOCKED BY PORTFOLIO: {slug} ({p_reason})")
            return

        # Execute Order
        res = self.exec_engine.execute_order(
            strategy_lane=strategy_lane,
            token_id=token_id,
            condition_id=signal_data["condition_id"],
            market_slug=slug,
            category=signal_data["category"],
            side=signal_data["side"],
            cash_budget_usd=budget,
            source_signal=signal_data["source_signal"],
            max_price_limit=self.config.golden_max_price
        )

        if res.success:
            self.token_cooldowns[token_id] = time.time()
            logger.info(f"[{strategy_lane}] TRADE EXECUTED ({res.trading_mode}): {slug} | {res.shares} shares @ ${res.all_in_price:.3f} all-in (Cash: ${res.cash_used_usd:.2f})")

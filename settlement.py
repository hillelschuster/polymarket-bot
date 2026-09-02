"""
Settlement Engine for Polymarket Enhanced (Multi-Tier Robust Resolver)
Reconciles terminal market resolutions against Polymarket Gamma API by:
1. Querying condition_ids directly
2. Querying event base-slugs with submarket matching
3. Checking outcomePrices ([0.999, 0.001]), closed status, and UMA settlement flags.
"""

import time
import logging
import json
import re
from typing import Optional, Dict, Any, List
from config import EnhancedConfig, load_config
from db import EnhancedDB
from http_client import global_http_session

logger = logging.getLogger("EnhancedBot.Settlement")
GAMMA_API_URL = "https://gamma-api.polymarket.com"

class SettlementEngine:
    def __init__(self, config: Optional[EnhancedConfig] = None, db: Optional[EnhancedDB] = None):
        self.config = config or load_config()
        self.db = db or EnhancedDB(self.config.db_path)

    def check_resolutions(self):
        open_positions = self.db.get_open_positions()
        if not open_positions:
            return

        now = time.time()
        for p in open_positions:
            token_id = p["token_id"]
            condition_id = p.get("condition_id")
            pos_id = p["position_id"]
            slug = p["market_slug"]
            cash_invested = p["cash_invested_usd"]
            shares = p["shares"]
            side = p["side"].upper()

            target_market = None

            # 1. Tier 1: Query Gamma by condition_id
            if condition_id:
                try:
                    url = f"{GAMMA_API_URL}/markets?condition_ids={condition_id}"
                    resp = global_http_session.get(url)
                    if resp.status_code == 200:
                        data = resp.json()
                        markets = data if isinstance(data, list) else data.get("data", []) if isinstance(data, dict) else []
                        if markets and len(markets) > 0:
                            target_market = markets[0]
                except Exception as e:
                    logger.debug(f"Error querying Gamma by condition_id {condition_id}: {e}")

            # 2. Tier 2: Query Gamma by event slug
            if not target_market and slug:
                try:
                    # Clean base slug (strip trailing submarket indicators)
                    base_slug = slug
                    for kw in ("-set-handicap", "-game-handicap", "-total-", "-spread-", "-btts"):
                        if kw in base_slug:
                            base_slug = base_slug.split(kw)[0]

                    url = f"{GAMMA_API_URL}/events?slug={base_slug}"
                    resp = global_http_session.get(url)
                    if resp.status_code == 200:
                        events = resp.json()
                        if events and isinstance(events, list) and len(events) > 0:
                            markets = events[0].get("markets", [])
                            if len(markets) == 1:
                                target_market = markets[0]
                            else:
                                for m in markets:
                                    clob_tokens = m.get("clobTokenIds", [])
                                    if isinstance(clob_tokens, str):
                                        try: clob_tokens = json.loads(clob_tokens)
                                        except: clob_tokens = []
                                    if isinstance(clob_tokens, list) and token_id in clob_tokens:
                                        target_market = m
                                        break
                                    if m.get("slug") == slug:
                                        target_market = m
                                        break
                except Exception as e:
                    logger.debug(f"Error querying Gamma by event slug {slug}: {e}")

            if not target_market:
                continue

            # 3. Check for Definitive Settlement
            uma_status = str(target_market.get("umaResolutionStatus") or "").lower()
            is_uma_resolved = (
                uma_status in ("resolved", "finalized")
                or target_market.get("umaResolved") is True
                or target_market.get("resolved") is True
            )
            is_closed = target_market.get("closed") is True or target_market.get("active") is False

            raw_prices = target_market.get("outcomePrices")
            prices = json.loads(raw_prices) if isinstance(raw_prices, str) else raw_prices
            has_definitive_prices = isinstance(prices, list) and len(prices) >= 2 and any(float(p_val) >= 0.90 for p_val in prices)

            winning_outcome_str = str(target_market.get("winningOutcome") or "").strip().upper()
            has_winning_outcome = winning_outcome_str in ("YES", "NO", "0", "1")

            is_truly_resolved = (is_uma_resolved or is_closed) and (has_definitive_prices or has_winning_outcome)

            if is_truly_resolved:
                is_pos_winner = False

                # Case A: By outcomePrices (e.g. [0.999, 0.001])
                if has_definitive_prices:
                    winning_idx = None
                    for idx, p_val in enumerate(prices):
                        if float(p_val) >= 0.90:
                            winning_idx = idx
                            break
                    
                    if winning_idx is not None:
                        clob_tokens = target_market.get("clobTokenIds", [])
                        if isinstance(clob_tokens, str):
                            try: clob_tokens = json.loads(clob_tokens)
                            except: clob_tokens = []

                        if isinstance(clob_tokens, list) and token_id in clob_tokens:
                            token_pos_idx = clob_tokens.index(token_id)
                            is_pos_winner = (token_pos_idx == winning_idx)
                        else:
                            is_pos_winner = (winning_idx == 0 if side == "YES" else winning_idx == 1)

                # Case B: By winningOutcome string
                elif has_winning_outcome:
                    is_pos_winner = (winning_outcome_str == side) or (winning_outcome_str == "1" and side == "YES") or (winning_outcome_str == "0" and side == "NO")

                # Calculate Terminal Realized PnL
                if is_pos_winner:
                    realized_pnl = (shares * 1.0) - cash_invested
                    outcome = "WIN"
                else:
                    realized_pnl = -cash_invested
                    outcome = "LOSS"

                self.db.update_position_resolution(
                    position_id=pos_id,
                    outcome=outcome,
                    realized_pnl=round(realized_pnl, 2),
                    closed_timestamp=now
                )
                self.db.log_event(
                    p["strategy_lane"],
                    "POSITION_RESOLVED",
                    f"Resolved {slug} as {outcome} | Realized PnL: ${realized_pnl:+.2f} (Stake: ${cash_invested:.2f})"
                )
                logger.info(f"[{p['strategy_lane']}] SETTLEMENT: {slug} | Outcome: {outcome} | Realized PnL: ${realized_pnl:+.2f}")

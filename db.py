"""
Database & Evidence Manager for Polymarket Enhanced Engine
Stores all runtime opportunities (accepted/rejected), open positions, and terminal settlements.
"""

import sqlite3
import json
import time
import os
import logging
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger("EnhancedBot.DB")

class EnhancedDB:
    def __init__(self, db_path: str = "enhanced_trades.db"):
        self.db_path = db_path
        self._shared_conn = None
        if db_path == ":memory:":
            self._shared_conn = sqlite3.connect(":memory:", timeout=30.0)
            self._shared_conn.row_factory = sqlite3.Row
        self._init_db()

    def _get_conn(self) -> sqlite3.Connection:
        if self._shared_conn is not None:
            return self._shared_conn
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        return conn

    def _init_db(self):
        conn = self._get_conn()
        try:
            # 1. Positions Table (Active and Resolved Economic Trades)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS positions (
                    position_id TEXT PRIMARY KEY,
                    strategy_lane TEXT NOT NULL,
                    token_id TEXT NOT NULL,
                    condition_id TEXT,
                    market_slug TEXT NOT NULL,
                    category TEXT NOT NULL,
                    side TEXT NOT NULL,
                    trading_mode TEXT NOT NULL,
                    entry_timestamp REAL NOT NULL,
                    shares REAL NOT NULL,
                    cash_invested_usd REAL NOT NULL,
                    entry_vwap REAL NOT NULL,
                    entry_fee_usd REAL NOT NULL,
                    all_in_entry_price REAL NOT NULL,
                    current_price REAL NOT NULL,
                    unrealized_pnl_usd REAL DEFAULT 0.0,
                    realized_pnl_usd REAL,
                    status TEXT NOT NULL,  -- 'OPEN', 'RESOLVED'
                    resolution_outcome TEXT, -- 'WIN', 'LOSS'
                    closed_timestamp REAL,
                    source_signal TEXT,
                    tx_hash TEXT
                );
            """)

            # 2. Opportunities Table (EVERY Opportunity Seen & Evaluated)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS opportunities (
                    opportunity_id TEXT PRIMARY KEY,
                    timestamp REAL NOT NULL,
                    market_slug TEXT NOT NULL,
                    token_id TEXT NOT NULL,
                    strategy_lane TEXT NOT NULL,
                    best_bid REAL,
                    best_ask REAL,
                    spread REAL,
                    depth_usd REAL,
                    price_band TEXT,
                    source_signal TEXT,
                    decision TEXT NOT NULL, -- 'ADMITTED', 'REJECTED'
                    rejection_reason TEXT,
                    evaluated_json TEXT
                );
            """)

            # 3. Audit Logs Table
            conn.execute("""
                CREATE TABLE IF NOT EXISTS audit_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp REAL NOT NULL,
                    event_type TEXT NOT NULL,
                    strategy_lane TEXT,
                    message TEXT NOT NULL,
                    details_json TEXT
                );
            """)
            conn.commit()
        finally:
            if self._shared_conn is None:
                conn.close()

    def log_opportunity(self, data: dict):
        conn = self._get_conn()
        try:
            conn.execute("""
                INSERT OR REPLACE INTO opportunities (
                    opportunity_id, timestamp, market_slug, token_id, strategy_lane,
                    best_bid, best_ask, spread, depth_usd, price_band,
                    source_signal, decision, rejection_reason, evaluated_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                data.get("opportunity_id", f"opp_{int(time.time()*1000)}_{data.get('token_id', '')[:6]}"),
                data.get("timestamp", time.time()),
                data.get("market_slug", ""),
                data.get("token_id", ""),
                data.get("strategy_lane", ""),
                data.get("best_bid", 0.0),
                data.get("best_ask", 0.0),
                data.get("spread", 0.0),
                data.get("depth_usd", 0.0),
                data.get("price_band", ""),
                data.get("source_signal", ""),
                data.get("decision", "REJECTED"),
                data.get("rejection_reason", ""),
                json.dumps(data.get("evaluated_json", {}))
            ))
            conn.commit()
        finally:
            if self._shared_conn is None:
                conn.close()

    def save_position(self, p: dict):
        conn = self._get_conn()
        try:
            conn.execute("""
                INSERT OR REPLACE INTO positions (
                    position_id, strategy_lane, token_id, condition_id, market_slug,
                    category, side, trading_mode, entry_timestamp, shares,
                    cash_invested_usd, entry_vwap, entry_fee_usd, all_in_entry_price,
                    current_price, unrealized_pnl_usd, realized_pnl_usd, status,
                    resolution_outcome, closed_timestamp, source_signal, tx_hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                p["position_id"], p["strategy_lane"], p["token_id"], p.get("condition_id"),
                p["market_slug"], p["category"], p["side"], p["trading_mode"],
                p["entry_timestamp"], p["shares"], p["cash_invested_usd"],
                p["entry_vwap"], p["entry_fee_usd"], p["all_in_entry_price"],
                p["current_price"], p.get("unrealized_pnl_usd", 0.0),
                p.get("realized_pnl_usd"), p["status"], p.get("resolution_outcome"),
                p.get("closed_timestamp"), p.get("source_signal"), p.get("tx_hash")
            ))
            conn.commit()
        finally:
            if self._shared_conn is None:
                conn.close()

    def get_open_positions(self) -> List[dict]:
        conn = self._get_conn()
        try:
            cur = conn.execute("SELECT * FROM positions WHERE status = 'OPEN' ORDER BY entry_timestamp DESC;")
            return [dict(r) for r in cur.fetchall()]
        finally:
            if self._shared_conn is None:
                conn.close()

    def update_position_resolution(self, position_id: str, outcome: str, realized_pnl: float, closed_timestamp: float):
        conn = self._get_conn()
        try:
            conn.execute("""
                UPDATE positions
                SET status = 'RESOLVED', resolution_outcome = ?, realized_pnl_usd = ?,
                    unrealized_pnl_usd = 0.0, closed_timestamp = ?
                WHERE position_id = ?;
            """, (outcome, realized_pnl, closed_timestamp, position_id))
            conn.commit()
        finally:
            if self._shared_conn is None:
                conn.close()

    def get_24h_realized_pnl(self) -> float:
        conn = self._get_conn()
        try:
            now = time.time()
            cur = conn.execute("""
                SELECT SUM(realized_pnl_usd) as pnl_24h
                FROM positions
                WHERE status = 'RESOLVED' AND closed_timestamp >= ?;
            """, (now - 86400.0,))
            row = cur.fetchone()
            return float(row["pnl_24h"] or 0.0) if row else 0.0
        finally:
            if self._shared_conn is None:
                conn.close()

    def log_event(self, strategy_lane: str, event_type: str, message: str, details: Optional[dict] = None):
        conn = self._get_conn()
        try:
            conn.execute("""
                INSERT INTO audit_logs (timestamp, event_type, strategy_lane, message, details_json)
                VALUES (?, ?, ?, ?, ?);
            """, (time.time(), event_type, strategy_lane, message, json.dumps(details or {})))
            conn.commit()
        finally:
            if self._shared_conn is None:
                conn.close()

    def get_portfolio_summary(self) -> dict:
        conn = self._get_conn()
        try:
            cur_pos = conn.execute("""
                SELECT 
                    COUNT(*) as total_trades,
                    SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) as open_count,
                    SUM(CASE WHEN status = 'OPEN' THEN cash_invested_usd ELSE 0.0 END) as open_exposure,
                    SUM(CASE WHEN status = 'RESOLVED' THEN 1 ELSE 0 END) as resolved_count,
                    SUM(CASE WHEN status = 'RESOLVED' AND resolution_outcome = 'WIN' THEN 1 ELSE 0 END) as win_count,
                    SUM(CASE WHEN status = 'RESOLVED' AND resolution_outcome = 'LOSS' THEN 1 ELSE 0 END) as loss_count,
                    SUM(CASE WHEN status = 'RESOLVED' THEN realized_pnl_usd ELSE 0.0 END) as total_realized_pnl,
                    SUM(CASE WHEN status = 'RESOLVED' THEN cash_invested_usd ELSE 0.0 END) as total_staked_resolved
                FROM positions;
            """)
            pos_row = dict(cur_pos.fetchone() or {})

            # By Strategy Lane
            cur_lanes = conn.execute("""
                SELECT 
                    strategy_lane,
                    COUNT(*) as n,
                    SUM(CASE WHEN status = 'RESOLVED' AND resolution_outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
                    SUM(CASE WHEN status = 'RESOLVED' AND resolution_outcome = 'LOSS' THEN 1 ELSE 0 END) as losses,
                    SUM(CASE WHEN status = 'RESOLVED' THEN realized_pnl_usd ELSE 0.0 END) as lane_pnl,
                    SUM(cash_invested_usd) as lane_staked
                FROM positions
                GROUP BY strategy_lane;
            """)
            lanes = [dict(r) for r in cur_lanes.fetchall()]

            # Opps count
            cur_opps = conn.execute("SELECT COUNT(*) as opps_seen, SUM(CASE WHEN decision = 'ADMITTED' THEN 1 ELSE 0 END) as admitted FROM opportunities;")
            opps_row = dict(cur_opps.fetchone() or {})

            return {
                "positions": pos_row,
                "lanes": lanes,
                "opportunities": opps_row
            }
        finally:
            if self._shared_conn is None:
                conn.close()

    def is_whale_on_cooldown(self, wallet_address: str, cooldown_hours: float = 24.0) -> Tuple[bool, Optional[str]]:
        """
        Streak filter: Returns (True, reason) if the specified whale wallet
        suffered a terminal LOSS within cooldown_hours.
        """
        if not wallet_address:
            return False, None
        conn = self._get_conn()
        try:
            cutoff = time.time() - (cooldown_hours * 3600.0)
            prefix = wallet_address.lower()[:10]
            cur = conn.execute("""
                SELECT market_slug, realized_pnl_usd, closed_timestamp
                FROM positions
                WHERE status = 'RESOLVED'
                  AND resolution_outcome = 'LOSS'
                  AND LOWER(source_signal) LIKE ?
                  AND closed_timestamp >= ?
                ORDER BY closed_timestamp DESC
                LIMIT 1;
            """, (f"%{prefix}%", cutoff))
            row = cur.fetchone()
            if row:
                hours_ago = (time.time() - row["closed_timestamp"]) / 3600.0
                return True, f"Whale {prefix} suffered loss on {row['market_slug']} ({hours_ago:.1f}h ago < {cooldown_hours}h cooldown)"
            return False, None
        finally:
            if self._shared_conn is None:
                conn.close()

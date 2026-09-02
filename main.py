"""
Polymarket Enhanced Daemon
Focus: ATP/ITF Tennis Moneylines & MLB Baseball Moneylines (Dual-Engine Replication)
"""

import time
import logging
import asyncio
import sys
from datetime import datetime
from config import load_config
from db import EnhancedDB
from execution import ExecutionEngine
from portfolio import PortfolioManager
from settlement import SettlementEngine
from market_scanner import MarketScanner

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [%(name)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger("EnhancedBot.Main")

async def run_enhanced_daemon():
    config = load_config()
    db = EnhancedDB(config.db_path)
    exec_engine = ExecutionEngine(config, db)
    portfolio = PortfolioManager(config, db)
    settlement = SettlementEngine(config, db)
    scanner = MarketScanner(config, db, exec_engine, portfolio)

    logger.info("=" * 80)
    logger.info("POLYMARKET ENHANCED ENGINE LAUNCHED")
    logger.info(f"Mode: {config.trading_mode} | Bankroll: ${config.bankroll_usd:.2f} | Max Loss: ${config.daily_max_loss_usd:.2f}")
    logger.info(f"Core 1: ATP/ITF Tennis Moneylines (${config.sizing_tennis_atp_itf_usd:.2f}/trade, 0.55-0.74)")
    logger.info(f"Core 2: MLB Baseball Moneylines (${config.sizing_baseball_mlb_usd:.2f}/trade, 0.55-0.74)")
    logger.info(f"Database: {config.db_path}")
    logger.info("=" * 80)

    last_scan = 0.0
    last_settlement = 0.0
    last_report = 0.0

    while True:
        now = time.time()

        # 1. Trade Stream & Whale Monitoring (Continuous)
        scanner.poll_whale_trade_stream()

        # 2. Active Gamma Markets Scan (Every scan_interval_seconds)
        if (now - last_scan) >= config.scan_interval_seconds:
            scanner.scan_active_gamma_markets()
            last_scan = now

        # 3. Settlement Check (Every settlement_interval_seconds)
        if (now - last_settlement) >= config.settlement_interval_seconds:
            settlement.check_resolutions()
            last_settlement = now

        # 4. Status Heartbeat Summary (Every 60s)
        if (now - last_report) >= 60.0:
            summary = db.get_portfolio_summary()
            pos = summary["positions"]
            opps = summary["opportunities"]
            logger.info("--- [PORTFOLIO STATUS] ---")
            logger.info(f"Opps Seen: {opps.get('opps_seen', 0)} | Admitted: {opps.get('admitted', 0)} | Open Positions: {pos.get('open_count', 0)} (${pos.get('open_exposure', 0.0):.2f})")
            logger.info(f"Resolved: {pos.get('resolved_count', 0)} ({pos.get('win_count', 0)}W / {pos.get('loss_count', 0)}L) | Realized Net PnL: ${pos.get('total_realized_pnl', 0.0):+.2f}")
            for lane in summary.get("lanes", []):
                logger.info(f"  Lane: {lane['strategy_lane']} | {lane['n']} trades | Wins: {lane['wins']} | PnL: ${lane['lane_pnl'] or 0.0:+.2f}")
            last_report = now

        await asyncio.sleep(1.0)

if __name__ == "__main__":
    try:
        asyncio.run(run_enhanced_daemon())
    except KeyboardInterrupt:
        logger.info("Polymarket Enhanced Engine shutdown gracefully.")

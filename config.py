"""
Configuration Module for Polymarket Enhanced Engine
Focus: High-EV Whale-Gated Execution on ATP/ITF Tennis & MLB Moneylines
"""

import os
from dataclasses import dataclass, field
from typing import Dict, List, Set

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

@dataclass
class EnhancedConfig:
    # 1. Trading Mode & Bankroll
    trading_mode: str = os.getenv("MODE", "paper").upper()  # "PAPER" or "LIVE"
    bankroll_usd: float = float(os.getenv("BANKROLL_USD", "500.00"))
    daily_max_loss_usd: float = float(os.getenv("DAILY_MAX_LOSS_USD", "35.00"))  # 7% hard stop
    max_open_positions: int = int(os.getenv("MAX_OPEN_POSITIONS", "15"))
    
    # 2. Sizing Allocation per Trade ($500 Bankroll Baseline)
    sizing_tennis_atp_itf_usd: float = float(os.getenv("SIZING_TENNIS_USD", "40.00"))   # 8% ($40 on $500)
    sizing_baseball_mlb_usd: float = float(os.getenv("SIZING_BASEBALL_USD", "35.00"))   # 7% ($35 on $500)
    sizing_soccer_2way_usd: float = float(os.getenv("SIZING_SOCCER_USD", "25.00"))      # 5% ($25 on $500)
    sizing_crypto_close_usd: float = float(os.getenv("SIZING_CRYPTO_USD", "25.00"))     # 5% ($25 on $500)
    min_order_notional_usd: float = 5.00
    
    # 3. Golden Alpha Execution Price Bands
    golden_min_price: float = 0.550
    golden_max_price: float = 0.740
    max_allowable_spread: float = 0.040  # 4 cents max spread
    min_book_depth_usd: float = 25.0     # Minimum viable depth
    
    # 4. Microstructure & Simulation Parity
    paper_depth_haircut: float = 0.30    # 30% resting depth discount
    paper_slippage_buffer: float = 0.005 # +0.5c slippage penalty per share
    
    # 5. Dynamic Category Fee Rates (Polymarket CLOB)
    fee_rates: Dict[str, float] = field(default_factory=lambda: {
        "crypto": 0.07,
        "sports": 0.05,
        "weather": 0.05,
        "politics": 0.04,
        "economics": 0.04,
        "default": 0.05
    })
    
    # 6. Complete Verified Sharp Whale Wallets (Top Tier-1 Sharps)
    tracked_whale_wallets: Set[str] = field(default_factory=lambda: {
        "0x1610db79f753a80207e1d66716be9e91e627ae49".lower(),  # ATP / Challenger Ace (80.0% WR)
        "0x6d3c5bd13984b2de47c3a88ddc455309aab3d294".lower(),  # Tennis & MLB Specialist (+34% ROI, 82% WR)
        "0x4f29e103339919c4baaea2a731efc1b4737fa2ad".lower(),  # Top Leaderboard Sharp (80.6% WR over 31 trades)
        "0x224a89dbe0db0d6124b335eb2ba1216d00472479".lower(),  # MLB Ace Specialist
        "0x5268527977f700f9bf9b6d5cd843859e4e70135d".lower(),  # High-Volume Tennis Sharp (Jianu & Broom winner)
    })
    whale_cooldown_hours: float = 24.0
    
    # 7. Polling Intervals
    scan_interval_seconds: float = 6.0
    settlement_interval_seconds: float = 15.0
    trades_stream_poll_seconds: float = 2.0
    
    # 8. API Endpoints
    clob_api_url: str = "https://clob.polymarket.com"
    gamma_api_url: str = "https://gamma-api.polymarket.com"
    data_api_url: str = "https://data-api.polymarket.com"
    rpc_url: str = os.getenv("POLYGON_RPC_URL", "https://polygon-rpc.com")
    
    # 9. Live Credentials (if MODE=live)
    private_key: str = os.getenv("POLYMARKET_PRIVATE_KEY", "")
    api_key: str = os.getenv("POLYMARKET_API_KEY", "")
    api_secret: str = os.getenv("POLYMARKET_API_SECRET", "")
    api_passphrase: str = os.getenv("POLYMARKET_API_PASSPHRASE", "")
    funder_address: str = os.getenv("POLYMARKET_FUNDER_ADDRESS", "")
    signature_type: int = int(os.getenv("POLYMARKET_SIGNATURE_TYPE", "0"))
    
    # 10. Database Path
    db_path: str = os.getenv("ENHANCED_DB_PATH", os.path.join(os.path.dirname(__file__), "enhanced_trades.db"))

def load_config() -> EnhancedConfig:
    return EnhancedConfig()

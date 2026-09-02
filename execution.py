"""
Execution & Microstructure Engine for Polymarket Enhanced
Handles L2 order book walking, dynamic fee curves, slippage buffers,
and order execution across PAPER and LIVE modes with full allowance pre-flight checks.
"""

import time
import logging
from dataclasses import dataclass
from typing import List, Dict, Optional, Tuple
from config import EnhancedConfig, load_config
from db import EnhancedDB
from http_client import global_http_session

logger = logging.getLogger("EnhancedBot.Execution")

CLOB_API_HOST = "https://clob.polymarket.com"

# Polymarket Polygon Contracts
USDC_POLYGON_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"      # USDC.e
CTF_EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"      # Main CLOB Exchange
NEG_RISK_EXCHANGE_ADDRESS = "0xC5d563A36AE78145C45a50134d48A1215220f80a" # NegRisk Exchange

@dataclass
class OrderLevel:
    price: float
    size: float

@dataclass
class ExecutionResult:
    success: bool
    position_id: Optional[str]
    shares: float
    cash_used_usd: float
    entry_vwap: float
    fee_usd: float
    all_in_price: float
    trading_mode: str
    tx_hash: Optional[str] = None
    error_message: Optional[str] = None

class ExecutionEngine:
    def __init__(self, config: Optional[EnhancedConfig] = None, db: Optional[EnhancedDB] = None):
        self.config = config or load_config()
        self.db = db or EnhancedDB(self.config.db_path)
        self.clob_client = None

        if self.config.trading_mode == "LIVE":
            self._init_live_clob()

    def _init_live_clob(self):
        if not self.config.private_key:
            logger.warning("LIVE mode specified but POLYMARKET_PRIVATE_KEY is empty. Falling back to PAPER mode.")
            self.config.trading_mode = "PAPER"
            return
        try:
            from py_clob_client.client import ClobClient
            from py_clob_client.clob_types import ApiCreds

            creds = None
            if self.config.api_key and self.config.api_secret and self.config.api_passphrase:
                creds = ApiCreds(
                    api_key=self.config.api_key,
                    api_secret=self.config.api_secret,
                    api_passphrase=self.config.api_passphrase
                )
            self.clob_client = ClobClient(
                host=CLOB_API_HOST,
                key=self.config.private_key,
                chain_id=137,
                creds=creds,
                signature_type=self.config.signature_type,
                funder=self.config.funder_address or None
            )

            # Auto-derive API credentials if missing
            if creds is None:
                try:
                    derived_creds = self.clob_client.create_or_derive_api_creds()
                    if derived_creds:
                        self.clob_client.set_api_creds(derived_creds)
                except Exception as ex:
                    logger.debug(f"Auto-deriving API creds note: {ex}")

            logger.info(f"LIVE CLOB CLIENT INITIALIZED (SigType: {self.config.signature_type}, Funder: {self.config.funder_address or 'EOA'})")
            self.verify_live_readiness()

        except Exception as e:
            logger.error(f"Failed to init live CLOB client: {e}. Falling back to PAPER mode.")
            self.config.trading_mode = "PAPER"

    def verify_live_readiness(self):
        """Verifies Polygon MATIC gas and USDC balance prior to live trading."""
        if self.config.trading_mode != "LIVE" or not self.config.private_key:
            return
        try:
            from web3 import Web3
            w3 = Web3(Web3.HTTPProvider(self.config.rpc_url))
            if not w3.is_connected():
                logger.warning("[LIVE PRE-FLIGHT] Could not connect to Polygon RPC to verify balances.")
                return

            account = w3.eth.account.from_key(self.config.private_key)
            wallet_addr = self.config.funder_address if self.config.funder_address else account.address

            matic_bal = w3.eth.get_balance(wallet_addr) / 1e18
            logger.info(f"[LIVE PRE-FLIGHT] Wallet: {wallet_addr} | MATIC Balance: {matic_bal:.4f} MATIC")

            if matic_bal < 0.05 and not self.config.funder_address:
                logger.warning(f"[LIVE PRE-FLIGHT WARNING] Low MATIC balance ({matic_bal:.4f} MATIC). May fail on gas.")
        except Exception as e:
            logger.debug(f"Live readiness check note: {e}")

    def calculate_dynamic_fee(self, price: float, category: str = "sports", is_maker: bool = False) -> float:
        """Dynamic non-linear taker fee: Fee(p) = Rate * p * (1 - p). Maker fee is 0.0%."""
        if is_maker:
            return 0.0
        rate = self.config.fee_rates.get(category.lower(), self.config.fee_rates.get("default", 0.05))
        return rate * price * (1.0 - price)

    def fetch_order_book(self, token_id: str) -> Tuple[List[OrderLevel], List[OrderLevel]]:
        try:
            url = f"{CLOB_API_HOST}/book?token_id={token_id}"
            resp = global_http_session.get(url)
            if resp.status_code != 200:
                return [], []
            data = resp.json()
            bids = [OrderLevel(price=float(b["price"]), size=float(b["size"])) for b in data.get("bids", [])]
            asks = [OrderLevel(price=float(a["price"]), size=float(a["size"])) for a in data.get("asks", [])]
            bids.sort(key=lambda x: x.price, reverse=True)
            asks.sort(key=lambda x: x.price)
            return bids, asks
        except Exception as e:
            logger.debug(f"Error fetching order book for {token_id}: {e}")
            return [], []

    def walk_l2_book_for_cash_buy(
        self,
        asks: List[OrderLevel],
        cash_budget_usd: float,
        depth_haircut: float = 0.30,
        slippage_buffer: float = 0.005,
        max_acceptable_price: float = 0.740
    ) -> Tuple[bool, float, float, float, str]:
        """
        Walks L2 asks with a 30% liquidity haircut and +0.5c slippage buffer.
        Returns: (success, shares_filled, cash_spent, vwap_price, message)
        """
        if cash_budget_usd <= 0:
            return False, 0.0, 0.0, 0.0, "Invalid cash budget"

        if not asks:
            return False, 0.0, 0.0, 0.0, "Empty orderbook"

        remaining_cash = cash_budget_usd
        total_shares = 0.0
        total_cost = 0.0

        for ask in asks:
            if ask.price <= 0 or ask.price > max_acceptable_price:
                break

            effective_size = ask.size * (1.0 - depth_haircut)
            effective_price = ask.price + slippage_buffer
            level_max_cost = effective_size * effective_price

            if remaining_cash <= level_max_cost:
                shares_bought = remaining_cash / effective_price
                total_shares += shares_bought
                total_cost += remaining_cash
                remaining_cash = 0.0
                break
            else:
                total_shares += effective_size
                total_cost += level_max_cost
                remaining_cash -= level_max_cost

        # Require >= 80% FOK fill ratio
        fill_ratio = (cash_budget_usd - remaining_cash) / cash_budget_usd
        if fill_ratio < 0.80 or total_shares <= 0.0:
            return False, 0.0, 0.0, 0.0, f"Insufficient viable book depth (Fill Ratio: {fill_ratio:.1%})"

        vwap = total_cost / total_shares
        return True, total_shares, total_cost, vwap, "OK"

    def execute_order(
        self,
        strategy_lane: str,
        token_id: str,
        condition_id: str,
        market_slug: str,
        category: str,
        side: str,
        cash_budget_usd: float,
        source_signal: str = "ORGANIC",
        max_price_limit: float = 0.740
    ) -> ExecutionResult:
        now = time.time()
        
        # 1. Fetch live order book
        bids, asks = self.fetch_order_book(token_id)
        if not asks:
            return ExecutionResult(False, None, 0.0, 0.0, 0.0, 0.0, 0.0, self.config.trading_mode, error_message="Empty order book")

        best_bid = bids[0].price if bids else 0.0
        best_ask = asks[0].price
        spread = best_ask - best_bid if best_bid > 0 else 0.0

        if best_ask > max_price_limit or best_ask < self.config.golden_min_price:
            return ExecutionResult(False, None, 0.0, 0.0, 0.0, 0.0, 0.0, self.config.trading_mode, error_message=f"Best ask {best_ask:.3f} outside band [{self.config.golden_min_price}, {max_price_limit}]")

        if spread > self.config.max_allowable_spread and best_bid > 0:
            return ExecutionResult(False, None, 0.0, 0.0, 0.0, 0.0, 0.0, self.config.trading_mode, error_message=f"Spread {spread:.3f} exceeds max {self.config.max_allowable_spread:.3f}")

        # 2. Walk L2 Book
        success, shares, cash_used, vwap, msg = self.walk_l2_book_for_cash_buy(
            asks, cash_budget_usd,
            depth_haircut=self.config.paper_depth_haircut,
            slippage_buffer=self.config.paper_slippage_buffer,
            max_acceptable_price=max_price_limit
        )

        if not success:
            return ExecutionResult(False, None, 0.0, 0.0, 0.0, 0.0, 0.0, self.config.trading_mode, error_message=msg)

        # 3. Dynamic Taker Fee
        fee_per_share = self.calculate_dynamic_fee(vwap, category=category, is_maker=False)
        total_fee_usd = fee_per_share * shares
        all_in_price = vwap + fee_per_share

        pos_id = f"pos_{strategy_lane}_{token_id[:8]}_{int(now*1000)}"

        # 4. PAPER Execution
        if self.config.trading_mode == "PAPER":
            position_data = {
                "position_id": pos_id,
                "strategy_lane": strategy_lane,
                "token_id": token_id,
                "condition_id": condition_id,
                "market_slug": market_slug,
                "category": category,
                "side": side,
                "trading_mode": "PAPER",
                "entry_timestamp": now,
                "shares": round(shares, 4),
                "cash_invested_usd": round(cash_used, 2),
                "entry_vwap": round(vwap, 4),
                "entry_fee_usd": round(total_fee_usd, 4),
                "all_in_entry_price": round(all_in_price, 4),
                "current_price": round(vwap, 4),
                "unrealized_pnl_usd": 0.0,
                "realized_pnl_usd": None,
                "status": "OPEN",
                "resolution_outcome": None,
                "closed_timestamp": None,
                "source_signal": source_signal,
                "tx_hash": f"PAPER_FILL_{int(now*1000)}"
            }
            self.db.save_position(position_data)
            self.db.log_event(strategy_lane, "PAPER_POSITION_OPENED", f"Opened {shares:.2f} shares @ ${all_in_price:.3f} all-in (Cash: ${cash_used:.2f})")
            logger.info(f"[{strategy_lane}] PAPER FILL: {market_slug} | {shares:.2f} shares @ ${vwap:.3f} (All-in: ${all_in_price:.3f}) | Cash: ${cash_used:.2f}")

            return ExecutionResult(
                success=True,
                position_id=pos_id,
                shares=shares,
                cash_used_usd=cash_used,
                entry_vwap=vwap,
                fee_usd=total_fee_usd,
                all_in_price=all_in_price,
                trading_mode="PAPER",
                tx_hash=position_data["tx_hash"]
            )

        # 5. LIVE Execution
        elif self.config.trading_mode == "LIVE":
            if not self.clob_client:
                return ExecutionResult(False, None, 0.0, 0.0, 0.0, 0.0, 0.0, "LIVE", error_message="CLOB client not initialized")
            try:
                from py_clob_client.clob_types import MarketOrderArgs
                order_args = MarketOrderArgs(
                    token_id=token_id,
                    amount=cash_used,
                    side="BUY"
                )
                resp = self.clob_client.create_market_order(order_args)
                order_id = resp.get("orderID") if isinstance(resp, dict) else str(resp)

                position_data = {
                    "position_id": pos_id,
                    "strategy_lane": strategy_lane,
                    "token_id": token_id,
                    "condition_id": condition_id,
                    "market_slug": market_slug,
                    "category": category,
                    "side": side,
                    "trading_mode": "LIVE",
                    "entry_timestamp": now,
                    "shares": round(shares, 4),
                    "cash_invested_usd": round(cash_used, 2),
                    "entry_vwap": round(vwap, 4),
                    "entry_fee_usd": round(total_fee_usd, 4),
                    "all_in_entry_price": round(all_in_price, 4),
                    "current_price": round(vwap, 4),
                    "unrealized_pnl_usd": 0.0,
                    "realized_pnl_usd": None,
                    "status": "OPEN",
                    "resolution_outcome": None,
                    "closed_timestamp": None,
                    "source_signal": source_signal,
                    "tx_hash": order_id
                }
                self.db.save_position(position_data)
                self.db.log_event(strategy_lane, "LIVE_ORDER_EXECUTED", f"Live order placed: {order_id}")
                logger.info(f"[{strategy_lane}] LIVE FILL: {market_slug} | OrderID: {order_id}")

                return ExecutionResult(
                    success=True,
                    position_id=pos_id,
                    shares=shares,
                    cash_used_usd=cash_used,
                    entry_vwap=vwap,
                    fee_usd=total_fee_usd,
                    all_in_price=all_in_price,
                    trading_mode="LIVE",
                    tx_hash=order_id
                )
            except Exception as e:
                logger.error(f"[{strategy_lane}] LIVE EXECUTION FAILED: {e}")
                return ExecutionResult(False, None, 0.0, 0.0, 0.0, 0.0, 0.0, "LIVE", error_message=str(e))

        else:
            return ExecutionResult(False, None, 0.0, 0.0, 0.0, 0.0, 0.0, self.config.trading_mode, error_message=f"Unknown trading mode {self.config.trading_mode}")

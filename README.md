# Polymarket Enhanced: Dual-Pillar Quantitative Engine

Polymarket Enhanced is a lean, standalone algorithmic execution bot engineered specifically to forward-test and exploit the two highest-expectancy, empirically proven market inefficiencies on Polymarket:

1. **CORE 1: ATP & ITF Tennis Moneylines** (Singles match winners in the 0.550–0.740 price band).
2. **CORE 2: MLB Baseball Moneylines** (Straight moneyline favorites in the 0.550–0.740 price band).

---

## Performance Foundation (Canonical Historical Ledger)

* **ATP & ITF Tennis Moneylines:** 53 Trades | 42W / 11L (79.2% WR) | **+$310.35 Net Realized PnL** (+29.1% ROI, PF 2.21)
* **MLB Baseball Moneylines:** 46 Trades | 38W / 8L (82.6% WR) | **+$239.65 Net Realized PnL** (+34.1% ROI, PF 2.45)
* **Combined Dual Engine:** 99 Trades | 80W / 19L (80.8% WR) | **+$550.00 Net Realized PnL** (+31.1% ROI, PF 2.31)

---

## Architectural Layout

```
polymarket-enhanced/
├── config.py           # Bankroll, price bands, sizing, and whale wallets
├── db.py               # SQLite WAL database for opportunities & positions
├── execution.py        # L2 orderbook walking, dynamic fees, paper/live routing
├── portfolio.py        # Bankroll risk gates and daily loss circuit breaker
├── settlement.py       # Terminal settlement reconciliation against Gamma API
├── market_scanner.py   # Live Gamma API polling and trade stream monitor
├── signals/
│   ├── __init__.py
│   ├── tennis.py       # ATP/ITF singles moneyline evaluator
│   ├── baseball.py     # MLB straight moneyline evaluator
│   ├── soccer.py       # 2-Way low totals and fading favorites evaluator
│   └── crypto_close.py # Hourly late-close and variance collapse evaluator
├── main.py             # Main async daemon loop
├── STATE.md            # Live runtime telemetry and state documentation
└── README.md
```

---

## How to Run

```bash
# 1. Navigate to directory
cd "C:\Users\הלל\Desktop\algo projects\Polymarket bots\polymarket-enhanced"

# 2. Run Paper Trading Engine
python main.py
```

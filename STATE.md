# POLYMARKET ENHANCED: LIVE RUNTIME STATE

**Project:** `polymarket-enhanced`  
**Current Date:** 2026-09-01  
**Configured Mode:** `MODE=paper`  
**Bankroll Baseline:** `$500.00 USD`  
**Daily Circuit Breaker:** `-$35.00 USD` (7% hard stop)  
**Status:** 🟢 **FULLY FUNCTIONAL & VERIFIED LIVE**

---

## 1. Strategy Engine Configuration

| Strategy Lane | Target Market & Restrictions | Golden Price Band | Stake Sizing ($500 Bankroll) | Execution Type | Status |
|:---|:---|:---:|:---:|:---:|:---:|
| **CORE 1: ATP / ITF Tennis** | ATP & ITF singles match winners (No WTA, no spreads/totals) | 0.550 – 0.740 | **$40.00 / trade** (8%) | Taker FOK (L2 Walked) | 🟢 **ACTIVE** |
| **CORE 2: MLB Baseball** | MLB straight match winners only (No run-lines, no totals) | 0.550 – 0.740 | **$35.00 / trade** (7%) | Taker FOK (L2 Walked) | 🟢 **ACTIVE** |
| **SAT 1: Soccer 2-Way** | Over 1.5, Over 2.5, BTTS YES, +1.5 spreads, Fade 1X2 | 0.550 – 0.720 | **$25.00 / trade** (5%) | Taker FOK (L2 Walked) | 🟢 **ACTIVE** |
| **SAT 2: Crypto Late-Close** | BTC & ETH hourly close contracts (Z >= 2.17, t <= 18s) | 0.550 – 0.740 | **$25.00 / trade** (5%) | Taker FOK (L2 Walked) | 🟢 **ACTIVE** |

---

## 2. Hardcoded Elimination of Unprofitable Traps

1. ⛔ **WTA Tennis Decoupled:** WTA excluded from primary automated tennis lane due to break-of-serve variance drag.
2. ⛔ **Run-Lines & Spreads Blacklist:** Excluded all -1.5 baseball spreads and set handicaps.
3. ⛔ **Soccer 3-Way Backing Blacklist:** Strictly prohibited buying YES on 3-way 1X2 favorites (eliminating 26% draw risk).
4. ⛔ **High Tail Totals Blacklist:** Strictly prohibited Over 3.5 total goals.
5. ⛔ **Mid-Event Stop-Losses 100% Prohibited:** Every position is held strictly to terminal UMA / Gamma settlement.

---

## 3. Microstructure & Parity Guarantees

* **L2 Depth Discount:** 30% discount on resting book depth (`paper_depth_haircut = 0.30`).
* **Slippage Buffer:** +0.5¢ penalty per share (`paper_slippage_buffer = 0.005`).
* **Dynamic Fee Schedule:** $F(p) = 	ext{Rate} \cdot p \cdot (1 - p)$ (5% for sports, 7% for crypto, 0% for maker).
* **Fill Ratio Requirement:** $\ge 80\%$ Fill-or-Kill ratio required or order is rejected.
* **Position Idempotency:** Duplicate positions on the same open market are strictly blocked.

---

## 4. Runtime Database Schema

* **Path:** `enhanced_trades.db` (SQLite in WAL mode)
* **Tables:**
  * `positions`: Active open and terminal settled economic positions.
  * `opportunities`: Complete historical audit log of every opportunity seen, price, spread, depth, decision (`ADMITTED` / `REJECTED`), and reason.
  * `audit_logs`: Engine runtime event log.

---

## 5. Launch & Operation Commands

To run the forward paper engine:
```powershell
cd "C:\Users\הלל\Desktop\algo projects\Polymarket bots\polymarket-enhanced"
python main.py
```

To run unit tests:
```powershell
cd "C:\Users\הלל\Desktop\algo projects\Polymarket bots\polymarket-enhanced"
python -m unittest discover -s tests
```

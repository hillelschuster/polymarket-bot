# High Win-Rate Trade Analysis Report

**Generated:** 2026-07-30T17:08:15.660Z
**Database:** [local SQLite — path redacted]
**Total trades:** 90 | **Resolved:** 49 | **Stop-lossed:** 12 | **Open:** 29

> READ-ONLY analysis. No modifications to bot or database.

---
## 1. The Critical Split: Resolution vs Stop-Loss

The single most important finding: **the stop-loss is destroying the edge.**

| Path | Trades | Wins | WR | Net PnL | ROI |
|---|---|---|---|---|---|
| **Hold-to-resolution** | 49 | 41 | 83.7% | +$130.76 | 16.7% |
| **Stop-loss exit** | 12 | 0 | 0.0% | $-147.87 | n/a |
| **Combined** | 61 | 41 | 67.2% | $-17.11 | -1.7% |

The hold-to-resolution path is **83.7% WR and +$130.76**. The 12 stop-losses wiped out **+$147.87**, turning a profitable signal into a net loss.

---
## 2. Overall Performance

| Metric | Value |
|---|---|
| Total trades | 90 |
| Completed (resolved + stop-loss) | 61 |
| Resolved (binary outcome) | 49 |
| Stop-lossed | 12 |
| Open | 29 |
| **Overall WR (completed)** | **67.2%** |
| **Hold-to-resolution WR** | **83.7%** |
| Net PnL (all completed) | $-17.11 |
| Net PnL (resolved only) | +$130.76 |
| Net PnL (stop-losses) | $-147.87 |
| Cash deployed | +$985.64 |
| Avg entry price | 0.7133 |
| Median entry price | 0.7210 |

### PnL Formula Verification

DB `realizedPnl` vs. formula `shares×(final-entry)` on 49 resolved trades:
- Max absolute difference: +$0.00
- Avg absolute difference: +$0.00
- **Verdict:** DB PnL is CORRECT. The bot's paper PnL accounting is sound.

### Open Trades

| Count | Unrealized PnL |
|---|---|
| 29 | $-23.87 |

---
## 3. Results by Entry-Price Bucket

Win rate means nothing without entry context.

| Entry bucket | Completed | Resolved | Res WR | Stop-loss | Net PnL | Res PnL | Avg entry |
|---|---|---|---|---|---|---|---|
| 0.55-0.65 | 11 | 8 | 87.5% | 3 | +$7.72 | +$46.56 | 0.628 |
| 0.65-0.70 | 12 | 10 | 70.0% | 2 | $-8.37 | +$10.89 | 0.680 |
| 0.70-0.75 | 24 | 20 | 85.0% | 4 | $-2.16 | +$46.15 | 0.726 |
| 0.75-0.80 | 10 | 7 | 100.0% | 3 | $-5.32 | +$36.14 | 0.775 |
| >=0.80 | 4 | 4 | 75.0% | 0 | $-8.98 | $-8.98 | 0.817 |

---
## 4. Results by Category

| Category | Completed | Resolved | Res WR | SL | Net PnL | Res PnL | Avg entry | Open |
|---|---|---|---|---|---|---|---|---|
| other | 28 | 22 | 72.7% | 6 | $-48.17 | +$27.51 | 0.696 | 9 |
| sports | 27 | 23 | 91.3% | 4 | +$39.36 | +$93.81 | 0.717 | 0 |
| macro | 3 | 3 | 100.0% | 0 | +$7.09 | +$7.09 | 0.809 | 1 |
| politics | 3 | 1 | 100.0% | 2 | $-15.39 | +$2.35 | 0.746 | 19 |

---
## 5. Results by Wallet (Top 12 by volume)

| Wallet | Completed | Resolved | Res WR | SL | Net PnL |
|---|---|---|---|---|---|
| STRATEGY:p | 6 | 4 | 100.0% | 2 | $-8.30 |
| 0x52685279 | 22 | 18 | 77.8% | 4 | $-27.89 |
| 0x076daa87 | 9 | 7 | 85.7% | 2 | +$5.23 |
| 0x4f29e103 | 4 | 3 | 100.0% | 1 | +$7.54 |
| 0x558f2f82 | 2 | 1 | 100.0% | 1 | $-7.11 |
| 0x31a1a31f | 2 | 2 | 100.0% | 0 | +$12.13 |
| 0xdb859a55 | 2 | 1 | 100.0% | 1 | $-4.13 |
| 0x88c4919d | 0 | 0 | n/a | 0 | +$0.00 |
| 0x2005d16a | 2 | 1 | 100.0% | 1 | $-4.73 |
| 0x9f208e85 | 0 | 0 | n/a | 0 | +$0.00 |
| 0x224a89db | 2 | 2 | 100.0% | 0 | +$9.55 |
| 0xfe787d2d | 1 | 1 | 100.0% | 0 | +$8.39 |

---
## 6. Results by Trading Day

| Day | Completed | Res WR | SL | Net PnL | Cumulative |
|---|---|---|---|---|---|
| 2026-07-21 | 4 | 100.0% | 0 | +$14.88 | +$14.88 |
| 2026-07-22 | 24 | 90.0% | 4 | +$38.58 | +$53.46 |
| 2026-07-23 | 3 | 100.0% | 2 | $-11.33 | +$42.13 |
| 2026-07-24 | 0 | n/a | 0 | +$0.00 | +$42.13 |
| 2026-07-25 | 6 | 100.0% | 1 | +$23.12 | +$65.25 |
| 2026-07-26 | 3 | 100.0% | 2 | $-17.67 | +$47.58 |
| 2026-07-27 | 3 | 100.0% | 2 | $-23.89 | +$23.69 |
| 2026-07-28 | 12 | 63.6% | 1 | $-34.24 | $-10.55 |
| 2026-07-29 | 5 | 80.0% | 0 | +$7.25 | $-3.30 |
| 2026-07-30 | 1 | 0.0% | 0 | $-13.81 | $-17.11 |

---
## 7. Stop-Loss Detail

All 12 stop-lossed trades (each one a position cut before resolution):

| Slug | Entry | Cash | PnL | Day |
|---|---|---|---|---|
| wta-waltert-sherif-2026-07-21 | 0.750 | $20 | $-12.30 | 2026-07-22 |
| atp-feldbau-buse-2026-07-22 | 0.610 | $20 | $-15.04 | 2026-07-22 |
| mlb-oak-ari-2026-07-22-spread-home-2pt5 | 0.769 | $20 | $-15.46 | 2026-07-22 |
| mlb-sf-kc-2026-07-22-spread-home-1pt5 | 0.731 | $20 | $-14.96 | 2026-07-22 |
| will-trump-meet-with-netanyahu-by-july-31-202 | 0.733 | $10 | $-9.04 | 2026-07-23 |
| will-trump-meet-with-benjamin-netanyahu-in-ju | 0.694 | $10 | $-8.70 | 2026-07-23 |
| wta-sherif-korpats-2026-07-25 | 0.634 | $13 | $-8.80 | 2026-07-25 |
| f1-hungarian-grand-prix-winner-norris-2026-07 | 0.731 | $14 | $-12.01 | 2026-07-26 |
| wta-hunter-johnson-2026-07-26 | 0.673 | $20 | $-10.56 | 2026-07-26 |
| atp-nishiko-shang-2026-07-27 | 0.624 | $20 | $-15.00 | 2026-07-27 |
| wta-samsono-keys-2026-07-27 | 0.769 | $20 | $-13.98 | 2026-07-27 |
| mlb-hou-laa-2026-07-27 | 0.769 | $14 | $-12.02 | 2026-07-28 |

---
## 8. Key Findings

1. **THE STOP-LOSS IS THE ENEMY.** Hold-to-resolution: 41/49 (83.7% WR), +$130.76. Stop-losses: 12 trades, $-147.87. The signal works; the risk management destroys it.
2. **Average entry price is 0.713** (median 0.721). Marginal zone — edge exists but is thinner than raw WR suggests.
3. **Sports: 23 resolved, 91.3% hold-to-res WR, +$93.81 resolved PnL, 4 stop-losses.**
4. **PnL formula:** DB accounting is CORRECT (0 mismatches on resolved trades).
5. **Wilson interval:** 41/49 resolved → 71.0% – 91.5%. At avg entry 0.713, break-even is 71.3%. Lower bound does NOT exceed break-even.
6. **Politics has 19 open trades** — resolution-speed bias: sports resolve fast, politics lingers.

---
## 9. Wilson Confidence Interval

For 41 wins in 49 resolved (hold-to-resolution) trades:
- Point estimate: 83.7%
- 95% Wilson interval: 71.0% – 91.5%

At avg entry 0.713, break-even probability is 71.3%.

---
*Generated by analysis/analyze.ts — read-only, no bot or DB modifications.*
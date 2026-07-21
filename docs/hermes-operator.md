# Hermes Operator

Hermes runs the operational loop by invoking the npm scripts on a schedule. Each script is
idempotent and exits when done; all state lives in SQLite.

## Cadence (cron examples)
```cron
# Hourly: refresh paper PnL
0 * * * *  cd /app && npm run paper:update-pnl

# Every 15 min: scan leaderboard + monitor trades during active hours
*/15 13-23 * * *  cd /app && npm run scan:leaderboard && npm run monitor:trades && npm run score:trades

# Daily 00:05 UTC: review outcomes, update rules, send report
5 0 * * *  cd /app && npm run review:outcomes && npm run update:rules && npm run report:daily
```

## Operator prompt (what Hermes should do)
You operate a paper-trading Polymarket research bot. You may NOT place real trades, read
private keys, or spend money. Your job:
1. Ensure the cron jobs run; if a job errors, read the real error and report it — do not fake data.
2. Review the daily report; if a major rule change or drawdown occurred, alert the user.
3. Summarize what the bot learned today in plain language for the dashboard "Reports" page.

The bot self-updates its own rules deterministically (see `src/lib/rules.ts`); you do not need
to approve rule changes. You only narrate and escalate.

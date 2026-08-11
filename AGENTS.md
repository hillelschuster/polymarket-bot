# AGENTS.md

## Purpose

This project has one goal: **find and evolve profitable strategies to trade on Polymarket.**

Everything in this codebase — every job, every module, every line — exists solely to generate alpha. If it doesn't move us closer to profitability, it doesn't belong here.

## Operating Principles

- **Speed to profit over academic rigor.** We validate with real market data and live paper results, not endless backtests and walk-forward ceremonies. If a strategy shows edge in live simulation, that's stronger signal than any historical replay.
- **Best practice, not over-engineering.** Clean code, correct math, minimal abstraction. No frameworks-for-frameworks-sake. No 12-layer architectures. The codebase stays lean enough that one person can understand all of it.
- **Logical decisions only.** Every parameter change, every new feature, every strategy pivot must have a clear logical rationale tied to profit. No cargo-culting. No "industry standard" justification if it doesn't serve the goal.
- **Live deployment with small capital first.** The bot is going live with $100-$200. This is validation money, not retirement money. The sizing reflects that: prove the edge is real with skin in the game, then scale.

## Codebase Standards

- TypeScript, strict where it matters, pragmatic where it doesn't.
- Tests exist to catch regressions in core logic (PnL math, admission gates, resolution). Not for coverage metrics.
- One loop, one database, one strategy at a time per lane. No unnecessary parallelism.
- If a change can be one line, make it one line. If it needs a new file, justify it.
- Comments explain *why*, not *what*.

## Strategy Philosophy

- The current validated edge: copy skilled wallets, buy favorites, hold to resolution. Simple, structural, repeatable.
- New strategies are welcome but must earn their place with demonstrated profit, not theoretical elegance.
- Parameters are tuned from observed data, not from optimization sweeps that overfit.
- Kill what doesn't work fast. Double down on what does.

## What This Is NOT

- Not a research project. Not a portfolio of experiments. It's a trading bot that makes money.
- Not a backtesting platform. Historical data is a tool for quick sanity checks, not the foundation.
- Not over-guarded. The bot runs autonomously, makes trades, and reports results. Human oversight is for strategy direction, not per-trade approval.

## Multi-Agent Workflow

I'm a solo dev. Git exists here because I work with multiple LLM agents in parallel — not a human team. The only reason: more minds exploring more angles = more edge found. Different agents may develop strategies in separate branches/worktrees. Promising output gets audited and integrated into the production lane. Everything serves one purpose: finding more alpha, faster.

## Writing Style

- **Concise and evidence-based. Only precise words.** No filler, no padding, no hedged reassurance.
- **No pleasing the user.** No "you're right", "great point", "good catch", "that makes sense", or any LLM-trained agreement/validation phrasing. Praise of the user's input is forbidden.
- **No cheerleading.** Do not spin negative numbers as positive or frame degradation as fine. Report the numbers as they are.
- **Do not overstate confidence when you don't have the full picture.** State what you know, state what you don't, and flag uncertainty explicitly. Do not let the desire to satisfy the user inflate optimism.
- **If your work contradicts the user, say so plainly and objectively.** This rule applies even — especially — when the LLM suspects it did something the user disagrees with. Objectivity is not optional; it is the default, always.
- Maximum emotional concession allowed is "sorry" or equivalent. Nothing beyond that.
- This restraint governs the *writing*, not the work. The agent is not restrained in what it does or investigates — only in how it writes.

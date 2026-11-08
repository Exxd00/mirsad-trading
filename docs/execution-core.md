# Mirsad EMA strategy — wallet execution contract

Version: **`mirsad-ema-15m-v1.0.0`**. Account: **`metamask-strategy-v1`**.

The owner requested the same strategy rules on MetaMask. [The Mirsad Sheet](https://docs.google.com/spreadsheets/d/1I4sXWpg5oImDvuXVm0yw4tX_Rg6MpXs4zV38zx1_3RA/edit), `ابدأ هنا!A15:C15` and `إعدادات الاستراتيجية!A1:F24`, together with `config/execution-v1.json`, define the baseline. Earlier `percentage-v2` rules and improvement candidates are historical.

## Unchanged rules

| Area | Required behavior |
| --- | --- |
| Market history | One approved fixed source; 15-minute candles; 1,000 contiguous completed warm-up bars; no invented gap filling or silent source switch. |
| Indicators | EMA20/50/200, each seeded by its own SMA and updated with alpha = 2/(N+1). |
| Buy signal | A new EMA20 cross above EMA50; close above EMA200; EMA200 above its value four bars earlier. Persist identity and consume a signal once. |
| Entry window | Less than 300 seconds after the signal close; limit price no more than close × 1.003; fresh source quotes. |
| Entry lifecycle | Limit order, downward quantity rounding, cancellation of its unfilled remainder after 60 seconds with a durable timer. A swap deadline is not proof of that lifecycle. |
| Allocation | 10% of available EUR including entry fees; 5% after two consecutive net losses or 2% flow-neutral drawdown. Never raise size to satisfy a minimum. |
| Restore | Three consecutive net wins and drawdown below 1%; breakeven breaks the streak; no allocation above 10%. |
| Capacity/exposure | At most three position/pending-buy symbols; at most 30% of documented account value, counting only the unfilled pending commitment once. Do not adopt pre-existing holdings. |
| Exit | Stop −2% or target +4% from actual average fill, or a reverse EMA cross after opening. Preserve prior stop levels; never widen a stop. Sell confirmed owned available quantity only. |
| Daily halt | A 1% loss during the Berlin day latches entry suspension until the next local day, even after recovery. Protection and reconciliation continue. Handle 23/25-hour days. |
| Cost cap | Round-trip cost ≤0.4%: both execution fees, spread once, additional slippage and documented fixed costs. Wallet estimates must also cover gas, approval and execution costs without double counting. Missing cost is not zero. |
| Cadence/ownership | Five-minute strategy scan; one order intent per cycle under the account lock and persistent source-write claim. Unresolved outcomes require reconciliation rather than a replacement order. |
| Freshness/protection | Quote age ≤15 seconds; account evidence ≤30 seconds; managed-protection target interval 10 seconds after a completed check. A protection heartbeat older than 30 seconds blocks new entries. |

The weekly loss, two-position/two-entry, hourly-breakout and 48-hour-exit rules in old `percentage-v2` material do not belong to this version.

## Wallet transport gate

The existing Base Sepolia pilot alternates exact swaps. It does not implement this table. The main strategy needs the complete typed wallet transport described in [wallet-execution.md](wallet-execution.md); entries remain blocked when any capability or risk evidence is missing.

An approved chain/account/token mapping must bind prices, candles, orders, fills and balances. EUR remains the accounting currency: do not label stablecoin units as EUR or assume a 1:1 rate. Record valuation source, event time and coverage; neutralize deposits and withdrawals without resetting drawdown.

Only finalized canonical network evidence can confirm wallet execution. Persist transaction identity before broadcast; reconcile a lost acknowledgement under that same identity. Unknown outcomes, conflicts, changed chain, incomplete coverage and missing fees are blockers.

## Source structure and verification

- `strategy.ts` / `feed.ts`: completed sequential EMA and source consistency.
- `planner.ts` / `risk.ts` / `protection.ts`: sizing, caps, exits, flow-neutral risk.
- `runner.ts` / `journal.ts` / `deadline.ts`: durable ownership, intent identity and cancellation.
- `wallet-venue.ts` / `source-model.ts`: normalized strategy adapter and evidence contract; types do not supply a production transport.
- `metrics.ts` / `reporting.ts` / `historical.ts`: confirmed results, named windows and signal replay.

Existing isolated tests cover these calculations and orchestration. Wallet acceptance must additionally prove mapping, limit/cancellation semantics, finality, gas accounting, expiry/revocation and recovery. Do not describe mocked fixtures as live execution.

## Reports and improvement

Measure confirmed closed trades separately from open positions and paper studies. Preserve fees, gas, slippage, source time, fill time, strategy version and account identity. Missing coverage or valuation remains unavailable. Compare the last 24 hours separately from the Berlin day and non-overlapping complete weeks.

The daily human/assistant review remains **05:00 Europe/Berlin**, Sunday within the same task. The internal report-generation window is a separate implementation detail and does not change that task. This document creates or activates no scheduler.

The internal daily report first becomes due at 09:00 Berlin. A missed wakeup can catch up later on the same local day; only a successful source read completes that day's report. A blocked read preserves the last successful snapshot and retries no sooner than the existing five-minute scan interval. Restarted and legacy blocked records cannot silently mark a report complete.

An execution-stage exception does not skip the independent read-only reporting pass. Each stage reports a sanitized failure separately, and reporting failure never reruns an execution cycle or repeats an order. These recovery rules neither install a wallet source nor grant, extend or activate financial authority.

Freeze v1 before evaluating a changed parameter. Record every candidate, training/evaluation windows, costs and decision, including failed candidates. Test on independent periods and keep a reversible version history. Automatic trading under fixed rules does not grant authority to change those rules or funding limits.

## History and deployment

Preserve historical database records and `reports/**` under their original source identity. Do not transplant earlier account balances, performance or protection records into the wallet account. Review [wallet-migration.md](wallet-migration.md) before any deployment. Source changes do not verify deployment, external key revocation or production credential cleanup.

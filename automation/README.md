# Mirsad scheduled monitoring

This implements automatic public-market research, not automatic brokerage execution. The existing account integration and manual order routes are unchanged. No broker credentials, initial cash balance, simulated fills, equity curve, or profit are created here. The old paper-forward experiment remains stopped and its data is preserved.

## Running components

- `mirsad-signal-monitor`: one Cron Trigger, `*/5 * * * *` UTC; rotates BTC-EUR, ETH-EUR and SOL-EUR. Each market is checked every 15 minutes, 24/7. The strategy uses completed one-hour candles only.
- Existing D1 binding: separate `monitor_*` tables, an atomic 60-second lease, unique symbol/candle ideas, an atomic two-idea daily cap in Europe/Berlin, indexed queries, bounded daily retention cleanup at 90 days. No private account data is published.
- `GET /report`: authenticated latest market observations, errors, last-24-hour scan counts and today's ideas. It never starts a run. POST/other routes are rejected. Requests without a valid signed token get 401.
- `/automation` in the existing authenticated Next.js app shows this report and clearly identifies the disabled order execution. Its server generates 30-second, report-only Ed25519 tokens. An independent signing key is generated on the first authenticated production visit, stored encrypted in the existing database, and never exposed to the browser. The Worker obtains only the public verification key from the fixed production origin; it has no secrets or account access. Preview deployments cannot sign report requests.
- Existing ChatGPT task at 09:00 Europe/Berlin: account-data transfer plus monitoring, recording and evidence-based review in the existing unified Sheet. It does not place orders or change strategy settings.

## Versioned experimental policy

`mirsad-hourly-breakout-v1` is an unvalidated starting hypothesis, not a claimed profitable/optimal strategy or individualized investment advice.

0–2 entry ideas per day; no forced daily trading. Long spot only, no leverage, no averaging down. EMA20 > EMA50; last closed one-hour close above the preceding 20 candle highs; positive volume in the last 21 bars; first 15 minutes after the close; ask no more than 0.5 ATR above close; spread <= 0.2%; quote <= 60 seconds old. Candle gaps, duplicates, invalid OHLC, zero-volume synthetic candles or stale feeds block ideas.

Reference stop = ask − 2 ATR14; target = ask + 4 ATR14. Allowed stop distance 0.5%–5%. Exit-review rules are close below EMA20 or 48 hours maximum holding time. These are proposals; they are not resting orders or guaranteed stop protection. No position lifecycle is fabricated.

Sizing function needs explicitly allocated capital, available cash, open-position exposure, instrument minimums/step, verified cost assumptions and reconciled performance. It does not read accounts or submit its output. Base loss budget 0.25%; maximum position notional 10%; combined exposure 20%; at most two positions. Quantity rounded down. Round-trip costs included. Initial cost assumptions: 0.09% fee plus 0.05% slippage each side; actual broker costs must be verified before sizing. No capital default.

Proposed risk reduction to 0.125% after two consecutive losses or 2% drawdown. Stop new risk at 1% daily loss, 3% weekly loss or 5% drawdown; no automatic resumption after a pause is implemented. Proposed increase only after >=30 days AND >=30 closed trades, net expectancy >0 R, profit factor >=1.2, drawdown <3%, no loss streak; +25% of prior risk, max 0.5%. Even eligible increases remain review proposals. The running monitor does not claim to enforce account loss limits: there is no verified performance/position feed or execution adapter. Deposits, transfers and balance changes are never interpreted as trading P&L.

## Free-plan budget and limits

288 scheduled invocations/day, two public GETs per invocation, no paid AI calls, no browser inside Workers. Small bounded JSON payloads, up to 100 analysed candles per market, indexed D1 summaries, <=2 ideas/day. Expected normal D1 writes are a few thousand rows/day including indexes, below Free's 100,000; reads well below 5 million/day. These are estimates; account quotas are shared with other workloads. Free Workers allow 100,000 requests/day and 10 ms CPU per invocation, including Cron. Network wait is not CPU. A live deployment still needs runtime error/CPU monitoring: local functional tests alone do not prove CPU compliance. Quota exhaustion produces an error, not an automatic paid upgrade.

Official limits checked 2026-09-24:
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/d1/platform/pricing/

## Deployment and verification

The deployed Cron and D1 run privately. `workers_dev` remains false because enabling an HTTP address was blocked by automatic approval review, including after signature authentication was added. The authenticated app report route is prepared but cannot reach the Worker until this endpoint is explicitly authorized. No public report was enabled.

Apply `migrations/0001_monitor.sql` to the existing D1. Deploy `worker.mjs` and `engine.mjs` as ES modules with the Wrangler configuration, then install the cron. Do not enable the old paper-forward cron. Do not add secrets: this component has no need for any.

`node --test automation/engine.test.mjs` tests rules and SQLite-backed dedupe, daily caps, leases, error persistence and report authentication. `npm run typecheck`, `npm test` and `npm run build` cover the application. The authenticated `/automation` page verifies real scheduled runs without triggering them. Direct unauthenticated report requests must return 401.

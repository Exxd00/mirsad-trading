# Mirsad educational execution

The current automation settles educational buy/sell operations only in the existing site's own ledger. It never submits financial orders. Existing broker integration, credentials, account APIs and manual order routes are unchanged and outside this component's scope.

## Running components

- `mirsad-signal-monitor` now runs `education-scheduler.mjs` with one `*/5 * * * *` cron. It sends one signed POST to the fixed production `/api/education/tick` endpoint. It has no browser or market/account/order provider calls.
- `EDUCATION_SCHEDULER_SIGNING_KEY_V1` is a dedicated Ed25519 application key in Cloudflare Secrets. Only its public verification key is in the repository. Preserve the secret on upload; never print, commit or expose its private value.
- The site authenticates method, route, timestamp, body and five-minute slot before database access. Preview writes are disabled. Duplicate or old slots cannot settle twice.
- `src/lib/education` reads only allowlisted public market GETs, then atomically settles balances, positions and fills in `app_settings` at `education:state:v1`. Market requests occur outside the database transaction. No broker client or credentials are used.
- `/automation` uses the existing owner session and CSRF protection. It shows execution, balances, performance, 24-hour counts with UTC/retention coverage, and expandable full report data.
- The current-account ChatGPT task runs daily at 09:00 Europe/Berlin, reads the visible report and updates the existing unified Sheet. It does not execute trades, change risk or use the old zen account.

## Balances and policy

Import one explicit existing snapshot with source, observation time and exact total/available/reserved decimals. There is no seeded money or reset. Identical imports are idempotent; a different replacement is rejected after initialization. Only available funds finance entries; imported holdings and reserves are preserved. Only new strategy-owned positions can be sold.

Capital anchors at the first complete valuation of opening available assets. Missing prices for a nonzero available asset block entries. The current feed supports BTC/ETH/SOL against EUR; other positive opening assets require an explicit valuation extension. Decimal accounting records both-side fees and net P&L from new strategy activity, not changes in imported holdings.

- Scan all three markets every five minutes. Enter on completed hourly EMA20 > EMA50 and a close above the preceding 20 highs, in the first 15 minutes. Require fresh quotes, valid candles, positive recent volume, spread <=0.2%, and no chase beyond 0.5 ATR.
- Zero to two entries per Berlin day, at most two open positions, no leverage. Risk 0.25%; position notional <=10%, aggregate exposure <=20%. Respect EUR availability, quantity steps and minimum orders.
- Stop distance 2 ATR14; target distance 4 ATR14; exit on an hourly close below EMA20 or after 48 hours. Exits run before entry filters at the next fresh polled bid. Stops are not resting orders or guaranteed prices.
- Educational costs are 0.09% fees and 0.05% adverse slippage per side, not statements of actual broker charges.
- Reduce risk to 0.125% after two consecutive losses or 2% drawdown. Pause new risk at 1% daily loss, 3% weekly loss or 5% drawdown. Gates are re-evaluated every cycle. The owner toggle pauses entries only; exits continue.
- A risk increase remains a proposal after >=100 closed trades and 56 days, positive net expectancy, profit factor >=1.2, maximum drawdown <3% and no loss streak. It is not applied automatically.

This is an unvalidated educational hypothesis, without a profitability claim. Keep 1,000 recent runs, 2,000 orders and 2,000 trades with lifetime aggregates; export earlier if detailed history must be retained indefinitely.

## Free-plan scope

The Worker makes 288 scheduled invocations/day and one outbound site request per invocation, with no D1 queries or paid AI calls. The site performs analysis and settlement under its own hosting/database quotas. Cloudflare Free allows 100,000 requests/day and 10 ms CPU per invocation, including cron; network waiting is not CPU.

One live invocation of deployment `4b2556d8-20a7-4515-8b8f-8116c1853d18` at `2026-09-24T23:35:53.848Z` succeeded with 1 ms CPU and 3,000 ms wall time. This measures one invocation, not every future run. Official limits checked 2026-09-24: https://developers.cloudflare.com/workers/platform/limits/

## Deployment and verification

Deploy the site first, explicitly import its existing snapshot and enable educational entries. Deploy the `main` module in `wrangler.jsonc`, preserving `secret_text` bindings and the existing cron. `workers_dev` and preview URLs remain disabled. The previously blocked Worker HTTP report endpoint was never enabled and is unnecessary for this outbound scheduler.

The old `worker.mjs`, `engine.mjs`, report-auth module, D1 binding and `monitor_*` data remain historical. They are not the current entry point or execution/performance source. Do not restart the old paper-forward experiment or rerun its migrations to operate this scheduler.

Verify with `npm test`, `npm run typecheck`, `npm run build` and `wrangler deploy --dry-run --config automation/wrangler.jsonc`. Regenerate declarations with `wrangler types automation/env.d.ts --include-runtime=false --config automation/wrangler.jsonc`. Confirm a real scheduled invocation and its matching saved site run; configuration alone does not prove execution.

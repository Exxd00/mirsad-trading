# Mirsad paper-forward Worker

Independent, deterministic BTC-EUR simulation on Cloudflare Workers + D1. No broker orders, account credentials, AI calls, Vercel configuration or app imports. The HTTP surface is only `GET /health`; all other paths/methods return 404.

## Experiment and accounting

- Batch `PAPER-BTC-EUR-FWD-20260924-v1`, strategy `sma-10-30-forward-v1`. The fixed ID is a label; `state.startedMs` records the actual first successful live initialization. Warm-up never fills a historical crossover.
- Closed hourly Revolut X public EEA candles, SMA 10/30, one long position, EUR 100 notional and EUR 1000 initial virtual cash; max hold 48 hours after the observed entry.
- Entry uses the current **ask** plus 5 bps assumed slippage; exit uses the current **bid** minus 5 bps. Fees are an assumed 10 bps per side on the actual simulated notional. Quotes are indicative public snapshots, not guaranteed fills or verified market depth. Source time, observed time and simulated execution time are separate fields.
- Signals older than 120 seconds are recorded as `missed_delay`, never filled retrospectively. Quote source time must be no more than 60 seconds old; its region and symbol must match. The deadline is checked again after network latency. Zero-volume candles never fill.
- `gross` uses slippage-adjusted fill prices. `net = gross - fees`; the informational `slippage` value is already included in gross and must not be subtracted twice. Persisted closed results are rounded to 8 decimals; cash uses unrounded arithmetic, so reconciliation tolerance is 1e-7 EUR.
- Each new candle is processed in order. Catch-up is bounded to 48 new candles per tick. Missing, malformed, conflicting or changed stored data blocks the entire affected pass without advancing the cursor. There is no alternate source or fabricated gap fill.
- Review flag after 30 closed results or 14 elapsed days; it does not modify the strategy or authorize expansion.

## Persistence and concurrency

The single versioned `state` JSON stores balance, open position, cursor, actual start and latest run. `candles`, `events`, `results` and `runs` provide durable evidence. Each commit uses one D1 `batch()` transaction. A SQL CHECK guard compares the version before any mutation. A stale invocation rolls back every write, even if its network request took longer than a minute. There is no expiring lease to accidentally release another invocation's lock.

Only one run per observed minute commits. Idle minutes perform no market-data request. Normal passes use at most two public GET requests and a bounded set of D1 statements (well below the Free plan's 50-query limit). Indexed reads avoid scanning old runs. No paid plan upgrade or subscription API mutation is part of deployment.

## Local verification

Requires Node 24+ (native TypeScript stripping in tests):

```sh
cd cloudflare-paper
npm ci
npm run typecheck
npm test
npm run dry-run
cd ..
node --test research/engine.test.mjs
```

Tests execute the engine against Miniflare D1, including real SQL transactions, rollback injection, concurrent calls, stalled calls, disk restart, gaps, source conflicts, outages, expiry, price/cost reconciliation and the public HTTP surface. Test fixtures stay local and are never inserted into remote D1. Runtime binding types are generated inside this package's ignored `node_modules/.cache` directory. `.mts` keeps the independent Worker outside the existing Next.js TypeScript include patterns.

## Deployment and operation

Deployed on 2026-09-24 to the existing Workers Free plan, confirmed by the user's dashboard screenshots (Free / Active / $0; no payment method). No subscription change was made.

| Resource | Verified value |
| --- | --- |
| Account | `61e259613cc3301fbf6ec781934ef976` |
| Worker | `mirsad-paper-forward` |
| D1, WEUR | `a397c9cf-ad63-42a5-8756-9ddde726acb3` |
| Migration | `0001_initial.sql`, applied 2026-09-24 11:21:41 UTC |
| Worker version | `56761480-3a33-4afb-86f8-ac706fef3fe4` |
| Deployment | `cce9a9c4-ae57-4db1-b175-c2543ab50fbc`, 100%, 11:36:42 UTC |
| Schedule | `* * * * *` |
| Configuration SHA-256 | `3727d60fc10e48095665eb45094b98f5f2d04e29d6759a65003646200371beb8` |

The first real cron wrote a blocked run at 11:26:53 UTC. After the second deployment, initialization succeeded at **2026-09-24T11:36:53.891Z**, storing 31 contiguous closed public EEA candles. D1 then recorded an `idle` run at 11:37:53 UTC with no error, no open position and no closed results. These are deployment observations, not test fixtures or performance claims. The ticker is validated when a timely trading signal needs a quote; live quote execution has not yet been observed.

Network reads use `redirect: 'manual'`: redirects are rejected as explicit HTTP errors and are never followed. A bounded network exception description is retained only in authenticated D1 run records, never in the public health response.

For later updates, reuse the existing database and account in `wrangler.jsonc`:

```sh
cd cloudflare-paper
npx wrangler whoami
npm run typecheck
npm test
npm run dry-run
npm run deploy
```

Use the authenticated Cloudflare connector equivalently if CLI authentication is unavailable. Do not recreate D1 or rerun initial SQL against this populated database. Use a new reviewed migration for future schema changes. Never upgrade the subscription as part of deployment.

After each deployment, read back the Worker version, D1 binding and schedule, then observe real cron-written `runs` rows. Cron configuration alone is not execution evidence. `https://mirsad-paper-forward.zenoura28.workers.dev/health` returns 503 until initialized, on a blocked pass, after 3 minutes without a run, or if D1 is unavailable. The handler returns 200 only for initialized recent operation. A local external probe received Cloudflare 403 / 1010, so public endpoint reachability is not established; authenticated D1 independently proves the running schedule and successful candle initialization.

## Daily Sheet ingestion

The daily task uses authenticated D1 **read-only** queries. All new writes belong to the canonical workbook `1I4sXWpg5oImDvuXVm0yw4tX_Rg6MpXs4zV38zx1_3RA`, in `تعريف المستقبل`, `نتائج المستقبل` and `قياسات المستقبل`. Historical BTC and archived SOL/MANUAL-001 retain their own definitions and ledgers. The existing 09:00 Europe/Berlin task remains authoritative; no duplicate task is needed.

```sql
SELECT version,payload FROM state WHERE id=1;
SELECT id,observed_ms,status,payload FROM runs ORDER BY observed_ms DESC LIMIT 5;
SELECT id,batch_id,closed_ms,payload FROM results
WHERE batch_id=? AND (closed_ms>? OR (closed_ms=? AND id>?))
ORDER BY closed_ms,id LIMIT 100;
```

Before ingestion, match the exact batch, strategy, symbol, currency and configuration hash, verify a real `startedMs`, contiguous closed-candle cursor and a recent non-blocked run (at most 3 minutes old). Page by `(closed_ms,id)` and use exact record IDs for deduplication; conflicting IDs require review. Preserve Sheet formulas. Empty `results` with healthy recent runs means no completed simulated trade; blocked/stale operation is not a zero-profit result.

After the user reconnected Cloudflare on 2026-09-24, an authenticated read from the other browser account succeeded. It returned state version 51, the exact expected batch and configuration hash, the original actual start, an `idle` run `PAPER-BTC-EUR-FWD-20260924-v1:29837537` with no error, zero closed results and zero rows written. A later independent read returned version 80 and another error-free idle run, confirming continued operation. Handoff `H-20260924-ACCESS-01` closes the account-access blocker M-011.

The existing daily task retains 09:00 Europe/Berlin and validates fresh source evidence on every run. If the connector explicitly reports authentication accepted and asks for a retry, retry the read once; report any remaining access failure. Source access is now verified, but unattended execution after this update and ingestion of the first real closed result remain unobserved. A saved task prompt or successful read is not proof that a result was imported.

## Provenance and status

Source ZIP supplied by the user: prototype commit `cd4b74848753b4e8e613e18de15b89993631bb41`, based on main `aee28ab0c232648fa52d10bafa78072a3d8ca720`. Its three original tests did not call Worker code. This revision replaces them with integration tests and fixes concurrency, missing closed-result accounting, quote freshness, actual slippage, incremental processing and real initialization.

Local validation: 17 Worker integration tests, typecheck and dry-run passed for the deployed source. The unchanged research engine previously passed its 14 tests. Deployment observations above were read directly from authenticated Cloudflare APIs and D1; they are separate from local verification.

Primary references:
- https://developer.revolut.com/docs/api/revolut-x-crypto-exchange
- https://developers.cloudflare.com/d1/worker-api/d1-database/
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/workers/best-practices/workers-best-practices/

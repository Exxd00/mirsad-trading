> **Current automatic execution engine (2026-09-26):** the supplied Execution Core 0.1 now lives in `src/lib/execution/`. The former education/monitor/research engines have been removed. The existing Mirsad educational account is connected as the data source. Execution remains disabled until the order adapter and signal source are completed. See [the current integration contract](docs/execution-core.md). Older automation descriptions below are historical.

# مرصاد | Mirsad

**Production storage verified:** Supabase is connected. Cloud login/logout, durable simulation, private API protection and table RLS were verified on 22 September 2026. 69 isolated tests pass. Private brokerage accounts are still not connected.

A private Arabic RTL workspace for **manual** market monitoring and trading decisions. The application is deployed and usable for authenticated public-market monitoring and isolated simulation. Supabase storage is verified; no private broker API account has been connected or verified. Real-order submission remains locked.

- Private repository: [Exxd00/mirsad-trading](https://github.com/Exxd00/mirsad-trading).
- Published site: [mirsad-trading.vercel.app](https://mirsad-trading.vercel.app), project `mirsad-trading` in the actual browser-accessible `ixa1` team. Production login, storage and public-market views are operational; private broker balances require account connection.
- Recoverable source checkpoint: `35cf64540b9141a0271da60bb80f5430ad2f6c51`. Later work may be ahead of that checkpoint; inspect Git before continuing.

## What is implemented

The responsive Arabic interface includes a login page, separate broker cards, market search and watchlists, timestamped bid/ask/spread readings, candlestick charts, positions/orders/fills views, secure connection settings, logout, and password change. PWA installation assets and a public offline page are included; the service worker never caches private navigation responses, account data, or APIs.

Official Revolut X EEA public market data powers the market views. The private Revolut X adapter and manual order engine are implemented but have not been exercised with this user's API credentials. Only market orders and GTC limit orders using base quantity are exposed. No Revolut retail stock-trading API is assumed. Interactive Brokers has a disconnected placeholder and researched integration contracts; an operational IBKR connector or persistent gateway has **not** been implemented or connected.

Every real order requires an enabled live gate, a fresh server-validated review, and a separate explicit confirmation. Durable intent IDs and broker client IDs prevent duplicate submission; unknown outcomes require reconciliation. Disabling the live gate only prevents new orders. The application does not decide investments, cancel orders automatically, close positions automatically, transfer funds, or add leverage.

`/simulation` is a clearly labelled, separate server-side ledger with virtual money and scripted full-fill, partial-fill, rejection, and connection-loss scenarios. It can use real public reference prices; its execution is not a live matching engine or evidence of achievable fills. Its balances and orders never appear on the real-account dashboard. Partial fills reserve the outstanding commitment; simulator remainders do not subsequently fill or cancel automatically.

## Run locally

Use Node.js 22 or later and pnpm:

```sh
pnpm install
pnpm db:init
pnpm dev
```

Before initialization, configure the names in `.env.example` through an ignored `.env.local`. The existing local workspace already has ignored development configuration, a salted initial-password hash, an encryption key, and durable local PGlite storage. Preserve that configuration without printing, committing, or copying its values into documentation. A new checkout must receive secrets securely; Git intentionally does not contain them.

Local development is available at `http://127.0.0.1:3000`. PGlite is for development only. Production and Vercel **require** `DATABASE_URL`; the app refuses an in-memory or local-file fallback in production. The schema is initialized by the database layer; `pnpm db:init` provides an explicit setup check.

```sh
pnpm test
pnpm typecheck
pnpm build
```

The verified checkpoint passed 69 automated tests, TypeScript checking, and a production build. Local browser checks covered desktop 1920×850 and mobile 390×844 without horizontal overflow. One local UI buy of 0.0001 BTC was executed **only in the isolated simulator**, with its virtual ledger updated. No real order, cancellation, modification, or transfer was used for verification.

## Deploy and connect

Use the existing private repository, Vercel project and Supabase project rqxxhpberxhpadgynrnw. Production storage and required server secrets are configured and verified. Preserve their values; do not provision duplicates or modify unrelated resources.

Browser environment-file upload works. Vercel CLI is installed but unauthenticated; the browser deployment workflow works. Keep production secrets in Vercel, use the exact deployed origin, and keep preview storage/secrets independent. Private broker access and live sending are additionally blocked in preview.

After the server is ready, the user can register an Ed25519 public key in their existing Revolut X account and enter the corresponding API key and private PEM through the authenticated site settings. Never send private keys through chat. Saving credentials performs reads only. A successful balances read verifies reading, not trading scope; trading scope is explicitly declared by the user and is not execution-tested. Keep live sending disabled until the user chooses to activate it. If their key requires an IP allowlist, resolve actual deployment egress first; no static-IP service has been purchased.

## Security and server environment names

Passwords use salted scrypt hashes. Session tokens are random, stored hashed, and transported in HttpOnly cookies with SameSite=Strict and Secure in production. Writes require an allowed origin and a session-bound CSRF token. Login and sensitive reauthentication are rate limited in the database. Broker secrets are encrypted server-side with AES-256-GCM and bound to the broker context. Password changes invalidate existing sessions.

Login is persistent: a session and its cookie last 400 days, and authenticated API reads renew that window after a day of use. Normal workspace visits and scheduled reads keep it current without storing the password. Unexpired older eight-hour sessions upgrade on their next authenticated read. Expired or revoked sessions require login; logout revokes the current session, and changing the password revokes every session. Clearing browser cookies also requires login. A daily read must use the same browser profile; a separate profile needs its own initial login.

| Environment variable | Purpose |
|---|---|
| `DATABASE_URL` | Durable production Postgres connection; server only |
| `DATABASE_PASSWORD` | Optional raw server-only password override; avoids manual URI encoding |
| `INITIAL_PASSWORD_HASH` | Initial salted password hash; never plaintext |
| `ENCRYPTION_KEY` | Server encryption/signing secret |
| `APP_ORIGIN` | Exact allowed site origin |
| `LOCAL_DATABASE_PATH` | Development-only durable PGlite location |
| `IBKR_BRIDGE_URL` | Reserved for a future IBKR bridge; currently unused/unconfigured |
| `IBKR_BRIDGE_TOKEN` | Reserved server secret for a future bridge; currently unused/unconfigured |

No secret values belong in this repository, client bundle, screenshots, logs, or documentation. The initial password's plaintext is deliberately absent. Read-only and trading permissions, banking cash, Revolut X assets, and IBKR funds must remain distinct. Missing acquisition cost, fees, or FX evidence is displayed as unavailable rather than guessed profit or buying power.

## Continue the work

[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) is the single requirements/dependencies ledger. [HANDOFF.md](HANDOFF.md) records the exact continuation point and pending user-only steps. [docs/BROKERS.md](docs/BROKERS.md) contains official API references, supported contracts, jurisdiction and session constraints, and test limitations.

Monitoring runs through polling while the app is open. There is no background trading bot, ongoing unattended execution, or newly enabled automation. The previous conversation heartbeat remains paused.


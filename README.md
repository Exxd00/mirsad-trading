# مرصاد | Mirsad

A private Arabic RTL workspace for **manual** market monitoring and trading decisions. The application is implemented, builds successfully, and has been verified locally. It is **not yet a connected production brokerage application**: durable production storage and server environment setup remain blocked, and no private broker API account has been verified. Real-order submission remains locked.

- Private repository: [Exxd00/mirsad-trading](https://github.com/Exxd00/mirsad-trading).
- Published site: [mirsad-trading.vercel.app](https://mirsad-trading.vercel.app), project `mirsad-trading` in the actual browser-accessible `ixa1` team. Initial deployment exists, but login/account functionality is not yet usable because production database and server secrets remain unconfigured.
- Recoverable source checkpoint: `bf7060671d53fb8397f55a3934ce44349ff7d826`. Later work may be ahead of that checkpoint; inspect Git before continuing.

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

The verified checkpoint passed 64 automated tests, TypeScript checking, and a production build. Local browser checks covered desktop 1920×850 and mobile 390×844 without horizontal overflow. One local UI buy of 0.0001 BTC was executed **only in the isolated simulator**, with its virtual ledger updated. No real order, cancellation, modification, or transfer was used for verification.

## Deploy and connect

Use the existing private repository and the existing Vercel project; do not create duplicates or modify unrelated projects. Complete durable free Postgres provisioning only after the user accepts the pending Neon technical terms. No database was created or purchased at the documented checkpoint. Then securely configure production variables, set the exact deployed origin, redeploy, and verify authentication and direct API protection on the actual deployed URL. A successful build alone does not establish production readiness.

The browser extension currently blocks environment-file upload until the user enables its **Allow access to file URLs** setting. The CLI device authentication attempt expired; it is not an authenticated deployment path. Prefer completing the already prepared browser workflow. Do not upload a development environment unchanged: production needs the production origin and durable database connection, without a local database fallback. Preview deployments require independent storage/secrets; broker access and live submission are additionally blocked in preview by the application.

After the server is ready, the user can register an Ed25519 public key in their existing Revolut X account and enter the corresponding API key and private PEM through the authenticated site settings. Never send private keys through chat. Saving credentials performs reads only. A successful balances read verifies reading, not trading scope; trading scope is explicitly declared by the user and is not execution-tested. Keep live sending disabled until the user chooses to activate it. If their key requires an IP allowlist, resolve actual deployment egress first; no static-IP service has been purchased.

## Security and server environment names

Passwords use salted scrypt hashes. Session tokens are random, stored hashed, and transported in HttpOnly cookies with SameSite=Strict and Secure in production. Writes require an allowed origin and a session-bound CSRF token. Login and sensitive reauthentication are rate limited in the database. Broker secrets are encrypted server-side with AES-256-GCM and bound to the broker context. Password changes invalidate existing sessions.

| Environment variable | Purpose |
|---|---|
| `DATABASE_URL` | Durable production Postgres connection; server only |
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

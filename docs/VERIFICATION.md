# Verification record

Last deployed HTTP inspection: **2026-09-21 23:55 UTC** (22 September 01:55 Europe/Berlin), after deployment of implementation commit `bf7060671d53fb8397f55a3934ce44349ff7d826`. Source comparison was performed at 23:52 UTC.

Follow-up on commit `21a32e934b55ad7e4a0889d0cb8c7b04c266034c`: production checker passed again at **23:57:40 UTC**. Vercel marked both production and `verification/protection` preview Ready. Anonymous requests to `/login` and `/api/dashboard` on preview `https://mirsad-trading-kzpk3r26d-ixa1.vercel.app` returned **302 to Vercel SSO**. This verifies the outer preview access barrier; authenticated preview account/market behavior remains unverified and has no configured database or broker credentials.

## Automated and local checks

- The complete suite passed **64 tests**, and the production build passed, in the root execution at approximately 01:51 Berlin.
- Security coverage includes salted scrypt hashing, session expiry/revocation, CSRF and exact Origin checks, database-backed throttling, authenticated encryption, protected direct API URLs, and expired sessions rejected before order/credential services run.
- Storage tests use an isolated PGlite database. A disk-backed close/reopen test confirms persisted settings survive reopening. Production has no temporary-database fallback.
- Order tests use injected fixtures with network calls prohibited. They cover concurrent confirmation/idempotency, account/credential binding, expiry, malformed/stale quotes, price drift, quantity/notional limits, the live gate, unknown outcomes without resubmission, rejection, partial fills, and reconciliation after owner-session renewal.
- A separate compiled production server on port 3001 verified authentication and CSP behavior. It was stopped after inspection.
- The local authenticated interface was exercised by the root agent. An isolated simulated order progressed from `UNKNOWN` to `FILLED` through explicit reconciliation of the same intent; no replacement submission was made.

## Compiled production HTTP checks

| Check | Local production build | Canonical Vercel deployment at inspection time |
| --- | --- | --- |
| `/login` | 200 | 200 |
| Fresh CSP nonce on repeated requests | Confirmed | Confirmed |
| Script tags carrying the response nonce | 10 of 10 | 10 of 10 |
| Production script `unsafe-inline` / `unsafe-eval` | Neither present | Neither present |
| Login response `no-store` | Confirmed | Confirmed |
| Anonymous `/api/session`, `/api/dashboard`, `/api/market`, `/api/settings` | All 401, all `no-store` | All 401, all `no-store` |
| Anonymous empty order confirmation | 401 | 401 with configured production Origin |
| Anonymous `/` and `/simulation` | 307 to `/login` | 307 to `/login` after deployed configuration fix |

The anonymous CSRF endpoint was also checked locally: it exposes only a CSRF token and sets a Secure, HttpOnly cookie. This public endpoint does not expose a session or account.

The generated deployment URL redirected anonymous requests to Vercel Deployment Protection. The canonical URL `https://mirsad-trading.vercel.app` was inspected directly. The blank-origin bug was fixed and redeployed; the table records the successful follow-up. Production CSRF bootstrap also returned a Secure, HttpOnly, SameSite=Strict cookie. Repeat these checks with `node scripts/verify-deployment.mjs https://mirsad-trading.vercel.app`; the script uses no account credentials, and its empty confirmation request stops at authentication.

## Source and client secret inspection

The inspection compared **51 publishable source/configuration files** (tracked plus non-ignored files awaiting the initial commit) and **14 compiled client assets** against the two configured private environment values. The initial password hash was normalized only in memory for escaped dollar signs and validated against the expected scrypt format. Source/client password-shaped candidates were checked without writing or printing a password.

- Files containing the configured private environment values: **0**.
- Initial-password plaintext candidates found: **0**.
- Secret values, plaintext passwords, and matching source excerpts were not printed or included in this report.
- Ignored environment files, runtime data, and build output are not intended for the repository.

This is a targeted comparison against available configuration values, not a claim that static scanning can detect every possible unknown secret.

## Browser and integration scope

The root agent verified the published login on desktop and at **390 × 844** mobile dimensions. RTL was present, and document width equalled scroll width (**390 px**), with no horizontal overflow. The complete authenticated dashboard was exercised locally only.

No authenticated cloud database session or private broker connection has been verified. No Revolut X private API key or Interactive Brokers API session was available for a verified account read. Public market-data checks are separate from account authentication and do not demonstrate broker-account access.

**No real trade, live cancellation, transfer, or financial test transaction was performed.** Live submission remains locked until the owner completes secure configuration and explicitly activates it inside the application.

## Supabase deployment checkpoint — 22 September 2026, 17:13 UTC

- User-entered DATABASE_URL saved as a Production Secret; hash and encryption key already saved as Production-only Secrets.
- Diagnosed and fixed SELF_SIGNED_CERT_IN_CHAIN using the official public Supabase CA, keeping certificate and hostname validation enabled. Credential-free TLSv1.3 probe passed.
- 68 tests and TypeScript passed; Vercel deployment Fag56Lo1F4oEh5uetTEnJLEbYG87 succeeded at source d9b167ecf9fcf1056d5cd49e17d331d818e61a82.
- Deployed login reached PostgreSQL authentication but received 28P01. Correct database credentials are still required. No authenticated cloud session or durable writes verified.
- Anonymous HTTPS protection, fresh nonce CSP and Secure/HttpOnly/SameSite login-CSRF cookie rechecked successfully at 17:13:35 UTC. No real brokerage actions.

At 17:16 UTC, the owner's second saved DATABASE_URL was redeployed, but login still reported 28P01. Added optional raw DATABASE_PASSWORD override, with a regression covering @, :, #, %, spaces, slash, plus and Unicode; 69 tests and TypeScript pass. Owner entry and deployed authenticated verification remain pending.

## Production acceptance — 22 September 2026, 17:39–17:43 UTC

The prior TLS/authentication blockers are RESOLVED after the owner saved raw DATABASE_PASSWORD and deployment J18hWSLGpyJubQo4wu8nsNnfDuFk completed. Website login succeeds and actual Supabase schema/session/storage operations work.

- Authenticated desktop 1920x850 and mobile 390x844 visually verified; mobile scroll width 375 <= viewport 390. No horizontal overflow. PWA installation control is offered, not installation-tested.
- Live dashboard has 0/2 brokers connected, blank real balances and live sending OFF. Official public Revolut X ticker/book/64 displayed candles updated with timestamps. Private broker access is NOT established.
- Virtual order 93de2376-572e-481c-bf76-8965da01e450 bought 0.0001 BTC in /simulation only. Fill and 9992.43 EUR virtual balance survived reload and logout/new login.
- Virtual order 0f8d2650-90d4-4a36-8307-07528c759acc used scripted UNKNOWN outcome. UI reconciliation returned FILLED with the same intent ID; exactly two virtual orders are displayed, no blind resubmission.
- Logout redirects to login. A subsequent direct /simulation navigation also redirects. New login succeeds. Real view remains separated from virtual balances/orders.
- Metadata-only production SQL query: app_owner, app_sessions, app_settings, audit_events, auth_rate_limits, broker_credentials, order_intents all RLS=true; anon/authenticated/service_role SELECT privilege=false for every table.
- Anonymous deployment checker passed at 17:40:29 UTC: private page redirects, private API 401/no-store, empty unauthenticated confirm rejected, nonce CSP and Secure/HttpOnly/SameSite login-CSRF cookie verified.
- Known-secret scan: 57 source files and 8 public login script assets, zero matches for stored initial hash/encryption key. Not an exhaustive security audit.
- 69 isolated tests and TypeScript previously passed; actual Vercel build passed. Partial-fill/duplicate/stale/session/ownership tests are isolated automated tests, not real broker trials.

No real financial trade, cancellation, transfer, paid subscription or brokerage account opening occurred. Private Revolut X and IBKR connection remain incomplete.


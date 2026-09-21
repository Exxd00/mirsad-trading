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

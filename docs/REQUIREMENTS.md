# Mirsad — consolidated delivery ledger

Updated: 2026-09-22. This is the single requirements/dependencies ledger. No live trade, cancellation, transfer, new financial account or paid subscription is authorized during build/testing.

| ID | Requirement | Dependency | Status / evidence |
|---|---|---|---|
| R01 | Inspect/reuse matching GitHub and Vercel project | Connected accounts | GitHub Exxd00 accessible; repository inventory inspected, no identified trading project. Vercel inventory has two unrelated projects; leave them untouched. |
| R02 | Private repository, production deployment, recoverable handoff | GitHub write and Vercel deploy | In progress; CLI not authenticated yet, connectors expose reads. |
| R03 | Arabic RTL responsive PWA, real market search/charts/watchlist | Official public market feed | In progress. No fabricated real-account values. |
| R04 | Server password hash, durable secure sessions, CSRF, throttling, logout/password change | Durable database; server secrets | In progress; no plaintext password in repository or client. |
| R05 | Separate actual Revolut X and IBKR accounts with verified permissions | User brokerage credentials/entitlements | Pending credential verification. Browser login alone is not API authorization. |
| R06 | Official broker adapters and supported capabilities only | Current official docs | Research in progress in BROKERS.md. No Revolut retail stock API assumed. |
| R07 | Balances, available cash, positions, orders, fills, conservative P&L | Authorized read APIs | In progress; show unavailable when access missing. |
| R08 | Manual order review/confirmation, live gate, kill switch | Verified trading permissions and explicit in-app activation | Live locked throughout build; no automatic investment decisions. |
| R09 | Persistent intent/idempotency, unknown outcome reconciliation, session/staleness guards | Database transaction + broker client IDs | In progress. |
| R10 | Isolated labelled simulation with partial fills/rejections/disconnection | Test-only simulated broker | In progress; never mixed into real account dashboard. |
| R11 | Secure server credential entry and preview isolation | Encryption key + HTTPS | In progress. No keys requested in conversation. |
| R12 | Auth/API/secret/account ownership/lifecycle tests, mobile/desktop published verification | Built app and deployment | Pending implementation. |
| R13 | README, environment names only, HANDOFF and GitHub checkpoints | Repository | Started. |

## Decisions

- Next.js App Router/TypeScript, server broker adapters, durable SQL state. Public quotes and candles are separate from private broker account data.
- Single owner password authentication; random server-side sessions; no secrets in public environment variables.
- No live broker operation during tests. Real order submission requires user activation and individual confirmation; unknown outcome never blindly retries.
- Polling while the app is open; no promise of continuous background trading or live WebSockets on short-lived Vercel functions.
- Revolut banking, retail securities, Revolut X, and IBKR are separate accounts. No merged buying power.
- Missing broker account, credentials, data subscriptions or persistent IBKR gateway do not block independent UI/security/market work.

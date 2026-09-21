# Continuation checkpoint — Mirsad / مرصاد

Updated 2026-09-22, Europe/Berlin. Read [the consolidated requirements ledger](docs/REQUIREMENTS.md) before changing scope. This is an implemented application with local verification, **not yet a verified connected production trading service**.

## Saved work and deployment identity

- Private GitHub repository: https://github.com/Exxd00/mirsad-trading
- Verified implementation checkpoint: `bf7060671d53fb8397f55a3934ce44349ff7d826`. Later documentation/checker commits may follow; inspect remote `main` before resuming. Code was pushed through the GitHub connector; the local Git index has not been committed. Do not force-push a new local root over the existing remote history.
- Actual browser-accessible Vercel workspace: team slug `ixa1`; project `mirsad-trading` was created and initially deployed through that UI.
- Published canonical URL: https://mirsad-trading.vercel.app. Verified implementation deployment: https://vercel.com/ixa1/mirsad-trading/65TqdmyZAWCzU23LM2NgXX7TghXD (Ready). The blank-origin startup issue is fixed and production APP_ORIGIN was saved. Anonymous private pages now redirect to login; private APIs reject access. Login itself is not usable until durable storage, password hash and encryption key are configured. Do not call the production app ready before those dependencies.
- The connector's stale inventory pointed to an unrelated Vercel team. It is not evidence about the actual `ixa1` project. Existing unrelated projects were left alone.

## Evidence already obtained

The code provides Arabic responsive UI/PWA, server authentication, CSRF, durable sessions/rate limits, encrypted credential storage, official Revolut X public/private adapters, manual order previews/confirmations, durable idempotency and reconciliation, a live gate/disable switch, and a separate server-backed simulator. IBKR currently has documentation and a disconnected placeholder, not an operational adapter.

The verified checkpoint passed **64 automated tests**, TypeScript, and a production build. Local authenticated browser checks used **1920×850 desktop** and **390×844 mobile** and found no horizontal overflow. Public Revolut X EEA reads returned **385 instruments and 1000 BTC-EUR candles**, plus live-source ticker/book data. That evidence is public market access only.

A local UI order bought **0.0001 BTC exclusively in `/simulation`**; the virtual fill and balances updated. Scripted tests cover full/partial fill accounting, outstanding reservations, rejection, ambiguity, idempotency, stale data/session/account guards, and authentication/security boundaries. See the test files and broker document for exact scope. No real trade, order cancellation/modification, transfer, new financial account, or paid subscription occurred.

## What is not connected or verified

- The user's actual Revolut X API settings page showed **No API keys**. No private balances/orders/fills API read was made with their account; browser login does not substitute for API authorization. Trading permission is not verified.
- No IBKR account authorization, API entitlement, market-data subscription, gateway, or persistent bridge was established. Its current implementation cannot route real IBKR orders.
- Production durable database provisioning is pending **user acceptance of Neon technical terms**. No database was created or purchased at this checkpoint.
- Secure production environment import is unfinished. The Chrome extension blocks file upload until the user enables **Allow access to file URLs**. The CLI device-auth attempt expired and is not an available authenticated deployment path.
- Published desktop/mobile authenticated flows, production broker egress, private account attribution, and actual broker P&L remain unverified. Published anonymous API/page protection, nonce CSP and login-page responsiveness have been verified; see docs/VERIFICATION.md.

The app must fail closed when production storage/secrets are missing. Do not replace durable storage with process memory or a Vercel local file to make a deployment look complete. A working public login shell alone is not a functional deployed private application.

## Next execution steps, in dependency order

1. Preserve the existing GitHub/Vercel association. The latest implementation deploy and anonymous boundary checks passed; start with the pending storage/configuration work rather than rebuilding the app. Both production and `verification/protection` at commit `21a32e934b55ad7e4a0889d0cb8c7b04c266034c` are Ready. The preview URL `https://mirsad-trading-kzpk3r26d-ixa1.vercel.app` redirects anonymous page and API requests to Vercel SSO. Do not create another preview/project just to repeat that check.
2. Have the user complete the pending free Neon technical-terms acceptance and browser extension file-upload permission. Do not accept financial agreements, purchase a plan, or treat elapsed time as consent.
3. Complete authorized durable database setup and securely import server configuration. Use production `APP_ORIGIN`, durable `DATABASE_URL`, `INITIAL_PASSWORD_HASH`, and `ENCRYPTION_KEY`; do not import local-only database settings into production. Keep preview storage/secrets separate.
4. Redeploy and verify the actual HTTPS site: login/logout/password change, session cookies, protected pages and direct API access, CSRF, public data freshness, simulation, and responsive desktop/mobile flows. No real transaction is a test.
5. Save the resulting code/doc changes to the same private GitHub repository. Update this file and the single ledger with exact URLs and evidence, preserving the distinction between local/simulated and private-account-verified outcomes.
6. Once the site is secure and usable, the user can create/register their own Ed25519 key pair for the existing Revolut X account and enter secrets through site settings. Verify balances/orders with read calls only. Display verified read access separately from user-declared trading scope. Keep live locked until the user activates it in-app.
7. If IBKR is still desired, require evidence of the user's existing authorized account and suitable persistent authenticated gateway/approved OAuth path before implementing and claiming that connection. Respect subscriptions, Germany/account restrictions, session renewal, and infrastructure limits.

## User-only actions collected together

The root agent has sent one consolidated asynchronous request for Neon technical-terms acceptance and the extension file-upload setting. Await the actual response; do not repeat that question or treat silence as approval.

- Accept the pending **technical** Neon terms for the free storage path, and enable the browser extension's local file-upload permission or complete secure environment import manually in Vercel. Never paste secrets into chat.
- After production server readiness, register the Revolut X public key and securely enter the associated API key/private PEM in the authenticated site's settings; confirm the actual EEA/Germany account and key scope. Resolve any key IP allowlist against real available egress.
- For optional IBKR work, authorize the existing account and provide its required persistent authenticated gateway/approved access and any relevant data entitlements. No new brokerage account or paid infrastructure is authorized.
- Real sending is a separate, voluntary user action inside the site after connection; each order still requires its own explicit confirmation. Connection setup does not authorize the agent to trade.

## Secret and continuity rules

The local `.env.local` is ignored and already contains development configuration, the salted password hash and encryption key; local PGlite data exists. Preserve these without printing values, committing them, or placing them in logs or screenshots. The exact secret values are intentionally not in GitHub and must be supplied securely on a fresh machine. Never regenerate an encryption key over stored broker ciphertext without a planned migration.

The ignored `.local/vercel-import.env` contains only the prepared server hash, encryption key and production origin for secure import. Add the eventual production database through the storage integration; do not publish this file. Vercel initially created seven empty variables from `.env.example`; only APP_ORIGIN has been populated. Empty DATABASE_URL/INITIAL_PASSWORD_HASH/ENCRYPTION_KEY still require setup. The second CLI login was also disabled in Vercel's device UI and was cancelled; no CLI authentication is available. The temporary production verification server was stopped; the local development server can be restarted with the documented dev command.

The application uses polling while open; it does not keep working after the session through a trading automation. The earlier conversation heartbeat is paused and must remain paused unless the user explicitly asks to restart it. Live order sending remains locked. No background auto-trader has been created.

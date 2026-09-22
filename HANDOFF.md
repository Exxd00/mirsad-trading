# Continuation checkpoint — Mirsad / مرصاد

Updated 22 September 2026, Europe/Berlin. Supabase replaces the earlier Neon plan. Read docs/REQUIREMENTS.md for the single requirements ledger.

## Saved resources and current state

- Private repository: https://github.com/Exxd00/mirsad-trading. Implementation checkpoint: 35cf64540b9141a0271da60bb80f5430ad2f6c51. Documentation commits follow; inspect remote main. The local index has no commits; never force-push a new root.
- Vercel: team ixa1, project mirsad-trading, https://mirsad-trading.vercel.app. Implementation deployment By35fYNYQhki69pHDA2E2iHJVRhd is Ready. Anonymous page/API protection passed. Authenticated cloud operation is blocked by database authentication (28P01); the URL is now saved, but Supabase rejects its password.
- Supabase project CREATED by the owner: rqxxhpberxhpadgynrnw, mirsad-trading, Free organization roxqtfpwtmiybnbrffcy, Central EU (Frankfurt). The refreshed overview reports Healthy with no advisor issues; the earlier startup warning cleared. Data API is confirmed disabled. Older projects were not changed.
- Actual Connect dialog Transaction pooler: aws-0-eu-central-1.pooler.supabase.com, port 6543, database postgres, username postgres.rqxxhpberxhpadgynrnw. Never guess a host or use the direct username here.
- Chrome file upload now WORKS. Existing INITIAL_PASSWORD_HASH and ENCRYPTION_KEY were updated successfully as write-only Secret variables scoped to Production only. APP_ORIGIN already points to the canonical URL. Imported .env initially produced duplicate-variable errors without saving; existing values were then edited successfully.
- DATABASE_URL was saved successfully as a Production Secret after the owner entered it. Redeployment exposed SELF_SIGNED_CERT_IN_CHAIN. This is fixed with the official Supabase public CA (source/fingerprint in docs/SUPABASE.md), preserving TLS and hostname verification. Latest deployment Fag56Lo1F4oEh5uetTEnJLEbYG87 is successful. Login then reports PostgreSQL 28P01, an authentication rejection; no cloud schema/session/persistence is verified. The owner corrected and saved DATABASE_URL again, but the 19:16 Berlin attempt still reports 28P01. To remove URI-encoding ambiguity, an optional server-only DATABASE_PASSWORD raw override is implemented and tested. A new Vercel Secret/Production form for DATABASE_PASSWORD is prepared, unsaved; the owner is asked to paste only the current project database password as-is and Save. Await that response, redeploy, and recheck once. Do not reset the database password yourself or repeatedly retry a rejected credential.

## Implemented and verified

Arabic RTL responsive PWA, server authentication and CSRF, secure cookies, durable sessions/rate limits, encrypted broker keys, separate account UI, public official Revolut X market adapter, manual order review/confirmation, durable idempotency/reconciliation, default live lock, and isolated simulator are implemented. Standard pg uses verified TLS and private tables enable RLS with API-role grants revoked. No production memory/filesystem fallback exists.

69 isolated tests and production build passed. Local durable storage and desktop/mobile authenticated flows passed. Public Revolut X EEA reads previously returned 385 instruments and 1000 BTC-EUR candles. Local simulated BTC orders only were tested, including unknown outcome reconciliation. Published anonymous pages redirect, private APIs return 401, CSP uses fresh nonces, and CSRF cookies have Secure/HttpOnly/SameSite Strict. Run scripts/verify-deployment.mjs for the anonymous check. See docs/VERIFICATION.md for evidence scope.

## Next actions

1. Await/check the owner's corrected DATABASE_URL; do not overwrite it with the placeholder. Preserve Vercel/Supabase handoff tabs. The password is not available to the agent and must not be requested in chat.
2. Redeploy once all production values are saved. Verify real TLS database connectivity, schema initialization, cloud login/logout, persistence, public market reads, isolated simulation and responsive desktop/mobile UI. Keep certificate verification enabled; diagnose any CA/pooler issue rather than disabling TLS checks.
3. Verify the production table RLS/grants and absence of private/API responses to anonymous clients. Keep preview secrets/storage separate. Existing preview verification/protection is already protected by Vercel SSO; no duplicate project is necessary.
4. Update docs and push to the existing private GitHub repository. Distinguish simulation/public market evidence from real private account reads.

## Remaining user-only broker dependencies

Actual Revolut X API settings showed No API keys. No private account API reads, balances, trading scope, P&L or account entitlements have been verified. After site readiness, the owner can register their Ed25519 public key and enter associated secrets in authenticated site settings; verify through read-only calls. Account/IP/EEA permissions still need checking.

IBKR is a disconnected placeholder with researched integration constraints, not an operational adapter. It needs an existing authorized account, data entitlements and suitable persistent authenticated gateway or approved access before implementation can be completed.

No financial order, cancellation, transfer, new financial account, paid subscription or new financial agreement was performed. Live sending stays locked until the owner enables it, and every future manual order requires individual confirmation. No autonomous trader exists.

## Secret and continuity rules

Preserve ignored .env.local, .local/database and .local/vercel-import.env. The import file contains the server hash, encryption key and production origin only; no DATABASE_URL. Do not print, commit or regenerate these secrets. Next dotenv expands dollar signs locally; Vercel stores literal hash dollar signs.

Official Vercel CLI is installed but not authenticated; browser deployment works. All work uses the existing project. App polling runs while open; there is no promise of background work. The earlier market heartbeat remains PAUSED.


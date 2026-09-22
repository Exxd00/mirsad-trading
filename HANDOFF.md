# Continuation checkpoint — Mirsad / مرصاد

Updated 22 September 2026, 19:43 Europe/Berlin. Supabase setup is COMPLETE and production login/storage are verified. Do not repeat provisioning or password setup.

## Resources and current evidence

- Private repository: https://github.com/Exxd00/mirsad-trading. Implementation checkpoint 35cf64540b9141a0271da60bb80f5430ad2f6c51; later documentation commits follow. Remote main is authoritative; local Git index has no commits. Never force-push a new local root.
- Live site: https://mirsad-trading.vercel.app. Vercel team ixa1, project mirsad-trading. Verified deployment: https://vercel.com/ixa1/mirsad-trading/J18hWSLGpyJubQo4wu8nsNnfDuFk (Ready, source 642553b3980169ee6e7d5e3d8bfa24e2e74ed0b7).
- Supabase: rqxxhpberxhpadgynrnw in Free organization roxqtfpwtmiybnbrffcy, Frankfurt. Transaction pooler aws-0-eu-central-1.pooler.supabase.com:6543, database postgres, username postgres.rqxxhpberxhpadgynrnw. No other projects changed.
- Production Secrets DATABASE_URL, DATABASE_PASSWORD, INITIAL_PASSWORD_HASH and ENCRYPTION_KEY are saved. APP_ORIGIN is the canonical URL. The raw DATABASE_PASSWORD override fixed the authentication blocker; preserve it. Never display its value or overwrite it with a URI placeholder.
- Official Supabase root CA is bundled as PUBLIC certificate material; TLS and hostname validation stay enabled. The prior TLS and 28P01 errors are resolved. Data API remains disabled.

## Verified on actual production

Successful owner login, private settings reads, real Revolut X PUBLIC ticker/book/candles, logout followed by redirect on private /simulation, and successful new login. Desktop 1920x850 and mobile 390x844 were visually checked; no horizontal overflow. Browser offers PWA installation; actual installation was not performed.

Two isolated CLOUD simulation buys of 0.0001 BTC each were tested: one normal fill, and one scripted UNKNOWN outcome reconciled to FILLED under the same intent ID. Exactly two simulated orders remain. The first fill survived reload and logout/new login. Virtual records remain only in /simulation; live accounts are disconnected and contain no synthetic balances. No real broker operation occurred.

A metadata-only query in the project's Supabase SQL Editor verified all seven app tables exist with RLS=true and SELECT privileges=false for anon, authenticated and service_role. No private rows/secrets were read for this check.

Anonymous cloud checks passed at 17:40:29 UTC: private pages redirect, APIs return 401/no-store, empty unauthenticated order-confirm request rejected, nonce CSP valid, Secure/HttpOnly/SameSite login-CSRF cookie. 69 isolated tests, TypeScript and production build passed. Secret scan: 57 source files and 8 public login script assets contained no saved initial hash or encryption key. Scope is these known secrets/assets, not an exhaustive security audit.

## Remaining requirements

Revolut X PRIVATE account access is not connected. Actual API settings previously showed No API keys. The owner must register an Ed25519 public key in their existing account and enter the corresponding API key/private PEM through authenticated site Settings. Never request private keys in chat. Then validate balances/orders by READ calls only, check EEA/Germany/account scope and any IP allowlist. Public feed access does not establish account trade permission or P&L.

IBKR remains a disconnected placeholder, not an operational adapter. It requires an existing authorized account, API/data entitlements and persistent authenticated gateway or approved alternative before implementation and verification. No new broker account or paid service is authorized.

Live sending remains OFF. Do not activate it, submit/cancel real orders, transfer funds or test with real money. The owner can voluntarily enable future manual sending inside the app; each order requires separate confirmation.

## Continuity

Preserve ignored .env.local, .local/database and .local/vercel-import.env. The last file has the initial hash, encryption key and origin only; database credentials are held in Vercel. Never regenerate encryption over existing ciphertext. CLI is installed but not authenticated; browser deployment and GitHub connector work. Keep preview secrets/database separate; existing verification/protection preview is Vercel-SSO protected. No need for another project or preview.

Update docs/REQUIREMENTS.md when scope changes. Polling runs while the app is open; no unattended trading or implied background work. Earlier market heartbeat stays PAUSED.

## Pending Revolut key registration — 22 September 2026

A new Ed25519 pair was generated locally for this site. Preserve ignored `.local/revolut-x/private-key.pem` and `.local/revolut-x/public-key.pem`; the private file has restricted Windows ACLs. Never print, commit or regenerate it. Public PEM SHA-256: `399bda21d6917893f57898406e24db230706c09a03b829ab4f5dead0ad5590e3`.

Revolut X API-key form is prepared in Chrome tab 779460322 at https://exchange.revolut.com/account/api-keys: Primary account, name `Mirsad - read only`, matching public key, Spot view only, Spot trade and MCP/CLI unchecked, no IP restriction or explicit expiry. Save has NOT been clicked. No broker API credential has been issued or uploaded. Action-time user approval was requested before granting the app new private financial-data access. Do not interpret this preparation as a connected account.

The existing intended durable design is Vercel server execution plus encrypted broker credentials in Supabase, protected by the existing Vercel ENCRYPTION_KEY. No duplicate service is required. After approval, register the key, handle any user 2FA, securely import credentials via authenticated site Settings, then verify private balances/orders by read calls only. Keep live sending OFF. The private PEM may need a secure file-import input added to Settings to avoid copying secrets through conversation. Never infer account-region confirmation from public feeds.

Hosting remains on free plans. Supabase documents possible automatic pausing after low activity over seven days: https://supabase.com/docs/guides/platform/free-project-pausing . Do not claim permanent uninterrupted availability or buy an upgrade without authorization.

Latest user reply requested disguising real-money operation as demo; it did not confirm the pending read-only grant. Registration remains unsubmitted. Do not replace real-account risk/confirmation labels with false demo claims. An isolated simulation or a privacy mode that hides values while preserving truthful execution labels are acceptable alternatives. Await a clear response on the pending broker access grant before submitting it.

## Neutral account wording and pending trade scope — 22 September 2026

Latest implementation e6b17387f01e70ea45e2770845db452065651537 uses neutral Arabic broker-account/order-sending labels. It does not label broker execution as simulation. Activation and order confirmation still explicitly explain that sending affects broker balances/positions and may lose funds. All locks, passwords, CSRF and per-order confirmations remain. TypeScript and all 69 tests passed; final follow-up changed only the simulation return-link text. Vercel deployment verification is pending.

The prepared Revolut form was changed, WITHOUT saving, to `Mirsad - manual trading`: Primary account, Spot view and Spot trade checked; MCP/CLI unchecked; no expiry or IP restriction. This supersedes the earlier read-only draft. A fresh action-time confirmation for issuance plus encrypted cloud storage was requested, and no approval has yet arrived. Do not submit until that confirmation arrives. No broker credential has been issued or connected. Site sending remains OFF.


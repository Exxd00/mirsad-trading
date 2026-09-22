# Supabase setup checkpoint

The owner selected Supabase instead of Neon on 22 September 2026. No Neon resource is needed. The existing signed-in Supabase organization is `roxqtfpwtmiybnbrffcy` on Free. Its three older projects were inspected only; none was changed or resumed.

The project was created by the owner: https://supabase.com/dashboard/project/rqxxhpberxhpadgynrnw, name mirsad-trading, Free, Central EU (Frankfurt). Data API is confirmed disabled. The initial overview also had a database-process advisor warning despite its Healthy badge; the refreshed overview later reported Healthy and no issues.

## Application changes

- Standard `pg` driver replaces the Neon-specific driver. Use Supabase's **Transaction pooler** connection string from Connect; do not guess its hostname. Its pooler username differs from a direct database username.
- `DATABASE_URL` is server-only. The pool verifies TLS certificates, uses at most two connections per instance, and does not create named prepared statements. Transactions and advisory transaction locks remain intact.
- Every application table enables RLS with no application API policies. Grants are revoked from PUBLIC and existing Supabase `anon`, `authenticated`, and `service_role` roles. The server connects as table owner. Keep Supabase Data API disabled; the browser talks only to the authenticated Next.js API.
- Development PGlite data is preserved; there is no production filesystem/in-memory fallback. No production data migration from Neon is required because no Neon database was created.
- 69 isolated tests and the production build passed. These do not yet establish a real Supabase database connection.

## Remaining secure configuration

1. Project creation is verified. Use the existing project rqxxhpberxhpadgynrnw; do not create a duplicate or modify older projects.
2. Obtain the actual Transaction pooler connection information through Supabase Connect. The owner should enter the database connection secret directly into the production `DATABASE_URL` field in Vercel, or use a secure environment import. Never paste credentials in conversation.
3. DONE: Chrome file upload works. INITIAL_PASSWORD_HASH and ENCRYPTION_KEY are saved as Secret variables for Production only; APP_ORIGIN is already correct. DATABASE_URL is saved but PostgreSQL rejects authentication (28P01). The owner has a fresh unsaved template to correct the current database password.
4. Redeploy and verify schema initialization, actual login/logout, persistence and isolated simulation over HTTPS. Read-only account verification still requires separate Revolut X credentials. Keep live trading off throughout setup.

The project has no need for Supabase Auth, Realtime or public client API keys at this stage. Existing application authentication is retained. Free projects may pause after low activity; this is not an always-on guarantee.

Official references: [connection methods](https://supabase.com/docs/guides/database/connecting-to-postgres), [API security](https://supabase.com/docs/guides/api/securing-your-api), [free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing).

Verified transaction pooler: aws-0-eu-central-1.pooler.supabase.com:6543; user postgres.rqxxhpberxhpadgynrnw; database postgres. Password values are intentionally omitted.

## Verified TLS correction, 22 September 19:13 Berlin

Production login first reported SELF_SIGNED_CERT_IN_CHAIN. Added the public root CA linked from this project's Database Settings: https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt. Fingerprint SHA-256: 80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA; expires 26 April 2031. src/lib/supabase-ca.ts is public certificate material, not a credential. It is trusted only for Supabase pooler/database hosts; rejectUnauthorized and hostname validation remain enabled. A credential-free local handshake verified TLSv1.3. The deployed app now reaches password authentication and reports 28P01. No successful database login, schema initialization or cloud persistence has been claimed.

## Current handoff: raw password override

The owner saved a second DATABASE_URL, but the 19:16 Berlin deployed login still returned 28P01. DATABASE_PASSWORD is now an optional server-only raw secret override; it encodes special characters exactly once before passing the URL to pg. A dedicated Secret/Production Vercel form is prepared for owner entry (password only, no URI/encoding). After save, redeploy before testing. 69 tests and TypeScript pass. Do not reset credentials or change Supabase settings without the required owner action.


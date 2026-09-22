# Supabase setup checkpoint

The owner selected Supabase instead of Neon on 22 September 2026. No Neon resource is needed. The existing signed-in Supabase organization is `roxqtfpwtmiybnbrffcy` on Free. Its three older projects were inspected only; none was changed or resumed.

The project was created by the owner: https://supabase.com/dashboard/project/rqxxhpberxhpadgynrnw, name mirsad-trading, Free, Central EU (Frankfurt). Data API is confirmed disabled. The initial overview also had a database-process advisor warning despite its Healthy badge; actual connectivity is not yet verified.

## Application changes

- Standard `pg` driver replaces the Neon-specific driver. Use Supabase's **Transaction pooler** connection string from Connect; do not guess its hostname. Its pooler username differs from a direct database username.
- `DATABASE_URL` is server-only. The pool verifies TLS certificates, uses at most two connections per instance, and does not create named prepared statements. Transactions and advisory transaction locks remain intact.
- Every application table enables RLS with no application API policies. Grants are revoked from PUBLIC and existing Supabase `anon`, `authenticated`, and `service_role` roles. The server connects as table owner. Keep Supabase Data API disabled; the browser talks only to the authenticated Next.js API.
- Development PGlite data is preserved; there is no production filesystem/in-memory fallback. No production data migration from Neon is required because no Neon database was created.
- 66 isolated tests and the production build passed. These do not yet establish a real Supabase database connection.

## Remaining secure configuration

1. Project creation is verified. Use the existing project rqxxhpberxhpadgynrnw; do not create a duplicate or modify older projects.
2. Obtain the actual Transaction pooler connection information through Supabase Connect. The owner should enter the database connection secret directly into the production `DATABASE_URL` field in Vercel, or use a secure environment import. Never paste credentials in conversation.
3. DONE: Chrome file upload works. INITIAL_PASSWORD_HASH and ENCRYPTION_KEY are saved as Secret variables for Production only; APP_ORIGIN is already correct. DATABASE_URL remains the only missing server value: the user has a prepared Vercel edit form and must enter their own password securely and save. The template has not been saved.
4. Redeploy and verify schema initialization, actual login/logout, persistence and isolated simulation over HTTPS. Read-only account verification still requires separate Revolut X credentials. Keep live trading off throughout setup.

The project has no need for Supabase Auth, Realtime or public client API keys at this stage. Existing application authentication is retained. Free projects may pause after low activity; this is not an always-on guarantee.

Official references: [connection methods](https://supabase.com/docs/guides/database/connecting-to-postgres), [API security](https://supabase.com/docs/guides/api/securing-your-api), [free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing).

Verified transaction pooler: aws-0-eu-central-1.pooler.supabase.com:6543; user postgres.rqxxhpberxhpadgynrnw; database postgres. Password values are intentionally omitted.


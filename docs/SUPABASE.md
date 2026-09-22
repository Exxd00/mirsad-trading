# Supabase setup checkpoint

The owner selected Supabase instead of Neon on 22 September 2026. No Neon resource is needed. The existing signed-in Supabase organization is `roxqtfpwtmiybnbrffcy` on Free. Its three older projects were inspected only; none was changed or resumed.

The new-project form is prepared at https://supabase.com/dashboard/new/roxqtfpwtmiybnbrffcy with name `mirsad-trading`, region **Central EU (Frankfurt)**, Data API **off**, automatic table exposure **off**, and automatic RLS **on**. Creation is not yet confirmed. The owner must complete the database credential field and submission in the browser; no database password is requested in chat.

## Application changes

- Standard `pg` driver replaces the Neon-specific driver. Use Supabase's **Transaction pooler** connection string from Connect; do not guess its hostname. Its pooler username differs from a direct database username.
- `DATABASE_URL` is server-only. The pool verifies TLS certificates, uses at most two connections per instance, and does not create named prepared statements. Transactions and advisory transaction locks remain intact.
- Every application table enables RLS with no application API policies. Grants are revoked from PUBLIC and existing Supabase `anon`, `authenticated`, and `service_role` roles. The server connects as table owner. Keep Supabase Data API disabled; the browser talks only to the authenticated Next.js API.
- Development PGlite data is preserved; there is no production filesystem/in-memory fallback. No production data migration from Neon is required because no Neon database was created.
- 66 isolated tests and the production build passed. These do not yet establish a real Supabase database connection.

## Remaining secure configuration

1. Verify that the owner completed the prepared project creation on the free plan. If Free capacity is exhausted, do not pause/delete an unrelated project or upgrade without specific authorization.
2. Obtain the actual Transaction pooler connection information through Supabase Connect. The owner should enter the database connection secret directly into the production `DATABASE_URL` field in Vercel, or use a secure environment import. Never paste credentials in conversation.
3. Securely import `INITIAL_PASSWORD_HASH` and `ENCRYPTION_KEY` from the already prepared ignored `.local/vercel-import.env`. `APP_ORIGIN` is already set for the canonical production domain. The current Chrome extension still blocks file upload until its Allow access to file URLs permission is enabled by the owner.
4. Redeploy and verify schema initialization, actual login/logout, persistence and isolated simulation over HTTPS. Read-only account verification still requires separate Revolut X credentials. Keep live trading off throughout setup.

The project has no need for Supabase Auth, Realtime or public client API keys at this stage. Existing application authentication is retained. Free projects may pause after low activity; this is not an always-on guarantee.

Official references: [connection methods](https://supabase.com/docs/guides/database/connecting-to-postgres), [API security](https://supabase.com/docs/guides/api/securing-your-api), [free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing).

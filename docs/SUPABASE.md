# Supabase — connected and verified

Project rqxxhpberxhpadgynrnw (mirsad-trading) is in the existing Free organization roxqtfpwtmiybnbrffcy, Central EU / Frankfurt. The owner created its database password. Older projects were not changed.

Production is connected as of 22 September 2026, 19:39 Berlin. DATABASE_URL and raw DATABASE_PASSWORD are stored as Vercel Production Secrets, along with INITIAL_PASSWORD_HASH and ENCRYPTION_KEY. APP_ORIGIN is configured. No secret values are recorded here. The raw password override resolved the earlier 28P01 rejection; preserve it and do not repeat credential setup.

The standard pg driver uses transaction pooler aws-0-eu-central-1.pooler.supabase.com:6543, database postgres, user postgres.rqxxhpberxhpadgynrnw. It verifies TLS certificates and hostnames, limits its pool to two clients, and uses no named prepared statements. Supabase Data API is disabled; the browser communicates through authenticated Next.js endpoints only.

## Certificate and verification

The public CA is the one linked by this project's Database Settings: https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt. SHA-256 fingerprint: 80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA; expiry 26 April 2031. src/lib/supabase-ca.ts contains public certificate material, scoped to Supabase database/pooler hosts. Certificate checking was never disabled.

Cloud login/logout/new login and simulation persistence passed. A metadata-only SQL check verified all seven private tables have RLS enabled and no SELECT grants for anon, authenticated or service_role. No private data was queried by that check. 69 isolated tests and TypeScript pass; Vercel production build is successful.

The free project can pause after low activity; this is not an always-on guarantee. No paid upgrade occurred. Supabase Auth/Realtime/public client keys are not required by this application.

Official references: [connection methods](https://supabase.com/docs/guides/database/connecting-to-postgres), [API security](https://supabase.com/docs/guides/api/securing-your-api), [free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing).


# Retired automatic workers

The current core is documented in [execution-core.md](../docs/execution-core.md).
`engine.mjs`, `worker.mjs` and the former education dispatcher have been removed.
The Wrangler target now uses `retired-scheduler.mjs` with an empty cron list.
Deploy that configuration to retire previously installed Cloudflare cron triggers.
Git changes alone do not redeploy Cloudflare. Old site tick requests return HTTP
410 once the updated site is deployed. No account data or D1 history is deleted.

`report-auth.mjs` remains a read-only report authentication utility, not an engine.

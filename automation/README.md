# Current execution Worker

Deploy only `execution-v1.wrangler.jsonc` for `mirsad-signal-monitor`.
The existing five-minute cron runs the strategy and wakes one account protection
alarm. That alarm calls authenticated `/api/execution/protect` every ten seconds
after completion, independently of the browser and candle analysis. It persists
in the existing `OrderDeadline` namespace alongside the individual cancellation
alarms. It does not arm trading or adopt old positions. Preserve this namespace,
its jobs, and the existing secret on deployment.

Read [execution-core.md](../docs/execution-core.md) for protection behavior and
the remaining entry-data requirements. Pausing entries must not stop protection.

## Retired automatic workers

The current core is documented in [execution-core.md](../docs/execution-core.md).
`engine.mjs`, `worker.mjs` and the former education dispatcher have been removed.
The legacy `wrangler.jsonc` targets `retired-scheduler.mjs` with an empty cron list.
Do not deploy that legacy configuration over the current execution Worker.
Git changes alone do not redeploy Cloudflare. Old site tick requests return HTTP
410 once the updated site is deployed. No account data or D1 history is deleted.

`report-auth.mjs` remains a read-only report authentication utility, not an engine.

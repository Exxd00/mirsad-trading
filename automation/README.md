# Existing wallet strategy Worker

`execution-v1.wrangler.jsonc` identifies the existing `mirsad-signal-monitor` Worker. The source configuration retains the five-minute strategy cadence and `OrderDeadline` Durable Object class. Editing these files does not deploy or activate a scheduler.

The active protection identity is **`mirsad-protection:metamask-strategy-v1`**. Its alarm calls the authenticated wallet protection route with a target interval of ten seconds after each completed check. Individual cancellation jobs keep their durable intent identities. The host must keep entries blocked until the complete wallet transport is ready.

Do not reuse the previous account's protection object as wallet state. Do not delete or rename historical objects, reset database balances, or assume old unresolved orders became wallet positions. Inventory existing deployed jobs before a cutover; preserving their storage is distinct from running the retired service.

Keep the existing `EXECUTION_SCHEDULER_TOKEN`, database encryption key, DO class and migration tags. No account private key belongs in the Worker. The Base Sepolia pilot is a separate exact-swap transport test and is not the EMA strategy.

`discovery.wrangler.jsonc` records the independent paper-discovery clock. Its removed market source has no fallback: unavailable observations must remain unavailable until an independent provider is implemented. Worker response health alone does not prove successful market collection or Sheet export.

`wrangler.jsonc` and `retired-scheduler.mjs` are the inactive legacy target with an empty cron list. Never deploy that target over the current Worker. Historical D1 data is not a wallet ledger and is not deleted by this migration. `report-auth.mjs` is a read-only authentication utility.

Read [execution-core.md](../docs/execution-core.md), [wallet-execution.md](../docs/wallet-execution.md) and [wallet-migration.md](../docs/wallet-migration.md). The daily review remains 05:00 Europe/Berlin; this change does not create or update it.

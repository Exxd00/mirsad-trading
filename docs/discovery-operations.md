# Paper discovery — source transition

Paper discovery is independent of wallet strategy execution and never authorizes a trade. The retired public-market integration must not be called as a fallback. Until an independent supported discovery provider is implemented and verified, fresh market observations are unavailable.

Active wallet research uses `discovery:wallet:v1:`. The old `discovery:paper:v1:` namespace remains an untouched archive and is not read, migrated or adopted as a wallet baseline. Provider-less runs cannot access market or Google Sheets networks, even when export credentials exist. Before enabling a concrete provider, verify a separate export destination or conflict-free starting row; the existing machine-owned tab contains historical rows that must not be overwritten.

The existing `mirsad-discovery-monitor` Worker calls authenticated `/api/discovery/tick` with `DISCOVERY_SCHEDULER_TOKEN`. Its source configuration records a one-minute cadence. This document does not publish a Worker, change its schedule or prove its live health. The worker carries no wallet spending grant and does not call execution routes.

## Preservation and future acceptance

- Preserve historical baseline, source events and outbox identifiers. Changing source requires an explicit new provider identity and baseline; do not classify all pre-existing pairs as new listings.
- Separate source time, observation time, scheduler status and export acknowledgement. A `/health` response or accepted HTTP request alone is not evidence of a completed observation.
- Keep paper assumptions, currencies and methods separate from finalized wallet fills and actual financial performance.
- Preserve unavailable outcomes as unavailable, never zero liquidity or invented profit.
- Keep the approved Google Sheet outbox and idempotent row mapping. Do not manually fill or overwrite source-owned rows to disguise export failures.

The approved Sheet is [Mirsad](https://docs.google.com/spreadsheets/d/1I4sXWpg5oImDvuXVm0yw4tX_Rg6MpXs4zV38zx1_3RA/edit); the machine-owned discovery tab is `رصد العملات الجديدة!A:J`. New provider configuration and adoption require their own implementation and verification.

The existing review remains **05:00 Europe/Berlin**, Sunday included in the same task. [discovery-review-prompt.md](discovery-review-prompt.md) describes its read-only boundary; do not recreate the task.

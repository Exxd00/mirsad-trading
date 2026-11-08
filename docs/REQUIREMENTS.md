# Current requirements — MetaMask strategy

The owner requested MetaMask-only execution with the existing **`mirsad-ema-15m-v1.0.0`** rules. [wallet-migration.md](wallet-migration.md) records the Sheet authority and obsolete baselines.

| Requirement | Acceptance boundary |
| --- | --- |
| Preserve rules | EMA15m, sizing, exposure, daily loss and exits match [execution-core.md](execution-core.md); no silent percentage-v2 reuse. |
| Wallet identity | Approved chain/account/token mapping binds every balance, price, order and receipt. |
| Execution transport | A typed implementation proves actual limit-order placement, 60-second unfilled cancellation, finality, reconciliation and protection. Pilot swaps do not satisfy this. |
| Accounting | Actual fills and costs including gas; dated EUR conversion; transfer-neutral valuation and complete coverage. Unknown values remain unavailable. |
| Fixed-rule automation | Existing authenticated scheduler and durable ownership; no duplicate engine, implicit arming or dependence on an open browser. |
| Fail closed | Missing mapping, data, costs, transport, grant, funds or health blocks new entries. |
| Historical preservation | No balance seeding, automatic ownership adoption, deleted trades or provenance changes in reports. |
| Retired connection | No runtime, credential or market-data fallback. External key revocation and production purge must be verified separately. |
| Paper discovery | An independent supported provider is required before fresh observations; previous results remain historical. |
| Improvement | Independent candidate evaluation after complete evidence; no autonomous rule or funding increase. |
| Operational evidence | Exact deployment revision, real scheduler check, grant scope and final receipts are separately verified. |

No line in this requirements table is evidence that the capability is operational. See [VERIFICATION.md](VERIFICATION.md).

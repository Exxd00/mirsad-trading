# Wallet-only migration checkpoint

Owner direction, **8 November 2026**: use MetaMask for all future execution, remove the previous integration, and retain the Mirsad Sheet's existing strategy. This document records local source work and remaining acceptance requirements, not a live account check.

## Strategy authority

Read [Mirsad](https://docs.google.com/spreadsheets/d/1I4sXWpg5oImDvuXVm0yw4tX_Rg6MpXs4zV38zx1_3RA/edit):

- `ابدأ هنا!A15:C15` explicitly selects **`mirsad-ema-15m-v1.0.0`** and labels older versions historical.
- `إعدادات الاستراتيجية!A1:F24` contains the current rules. The bounded read through row 100 found content only through row 24.
- `config/execution-v1.json` retains the numerical rules and assigns the isolated account `metamask-strategy-v1`.
- `خطة التحسين!A2:D18` still references `candidate-v3` / `percentage-v2`; `دليل النظام!A10:D35` includes hourly breakout, two-position and other older rules. They are not the active strategy.
- `المراجعات والتحسينات!A2:F3` keeps the v1 rules fixed and requires independent evaluation for a changed parameter. Earlier metric rows are dated evidence, not current wallet performance.

The strategy rules and acceptance matrix are in [execution-core.md](execution-core.md). Do not silently change limit entry into a swap, EUR into a stablecoin or the 0.4% cost ceiling into a higher wallet allowance.

## Integration and historical storage

Current strategy identity is `metamask-strategy-v1`, with protection object `mirsad-protection:metamask-strategy-v1`. The former `revolut-x` database/account keys and protection objects are **archival identities, not reused or renamed**.

Preserve trades, decisions, orders, fills, performance observations, audit events, pending identities and `reports/**` with their original provenance. Do not wipe balances, fabricate a wallet starting balance, transfer old risk outcomes into wallet streaks or adopt pre-existing wallet tokens as managed positions.

The two provider-specific research collection/analysis scripts were retired. Existing research outputs remain historical and are not regenerated with a different source under the same identity. Historical report references to those scripts describe their original provenance.

Credential cleanup is separate from history preservation. A local explicit purge utility can remove obsolete encrypted connection/settings material without deleting trades; creating that utility does not prove it ran in production. **Production credential purge and external API-key revocation have not been verified.** Removing runtime calls does not revoke a key at its issuer. No external account, support conversation or key-management screen was operated by this local source change.

## Remaining operational blockers

1. **Deployment:** the reconstructed 7 November checkpoint said Vercel identity verification blocked redeployment. Verify the actual current deployment and reviewed revision before any claim that local changes are live.
2. **Transport:** implement the typed strategy transport, approved chain/account/token mapping, real limit/cancel-60-second semantics, finalized execution evidence, EUR valuation and complete gas/cost accounting. Until then the main strategy remains unconnected/blocked.
3. **Authority/funding:** the owner must choose the actual chain, token mapping, funding and duration limits before a bounded wallet delegation. Browser read access supplies none of these permissions.
4. **Independent paper data:** discovery cannot continue fresh collection through the removed public provider. Keep it unavailable until a separately supported source and source-transition baseline are verified.
5. **Cloud resources:** inventory existing Worker/DO jobs and data before a cutover; preserve historical storage and verify the intended wallet object. This source change neither deploys a Worker nor activates or recreates a scheduler.
6. **External credentials:** separately verify issuer revocation and production purge without printing secrets or deleting history.

The existing Base Sepolia84532 USDC/WETH pilot is an exact-swap transport exercise. The recorded Ethereum chain1 connection is read-only. Neither proves the main strategy's execution or profitability.

## Sheet reconciliation and source isolation

On 8 November the current account/source instructions, source limitations and version references were reconciled in the Sheet using its cooperative lock and bounded native writes with readback. Numerical trading rules were retained. The older system guide and improvement proposal were labelled historical. The scheduled task and controller were not changed. The final delivery records the reviewed code revision and remaining operational blockers; no Sheet entry proves deployment or live trading.

Discovery uses the isolated `discovery:wallet:v1:` namespace. Historical `discovery:paper:v1:` data, leases and outbox remain unchanged and are not adopted by the new source. Missing provider configuration blocks network access and export; a future provider must establish its own baseline and a verified, conflict-free export destination.

| Range | Required reconciliation |
| --- | --- |
| `إعدادات الاستراتيجية!B3:C3` | Replace stale educational account identity with the isolated wallet strategy identity; do not copy its old ledger. |
| `إعدادات الاستراتيجية!C5` | Replace retired market source with an approved wallet source only after actual implementation; otherwise label unavailable. |
| `إعدادات الاستراتيجية!B12:C12` | Preserve EUR sizing semantics and document dated conversion when the wallet holds another quote asset; no 1:1 assumption. |
| `إعدادات الاستراتيجية!A23:C24` | Distinguish the existing 05:00 review from older 09:00/internal report wording; record transport blockers accurately. |
| `دليل النظام!A5:D10`, `A13:D35`, `A44:D46` | Label obsolete source/version/control instructions historical and point current readers to v1, rather than treating old risk or improvement thresholds as active. |
| `عقد الربط!A5:D8`, `A16:D16`, `A28:D28` | Distinguish the old read-only handoff contract from the owner's current implementation request; update active source/control references without changing the daily review's read-only scope. |
| `خطة التحسين!A2:D18` | Preserve as historical hypotheses; any current improvement plan must identify v1 as baseline, isolate candidate tests and retain fixed risk limits. |
| `جدولة المتابعة!C24:D24` | The current Sheet text already selects MetaMask and paper discovery at 05:00; note unavailable replacement source and verify cloud-task parity separately. Do not rewrite/create scheduled tasks during source cleanup. |
| `المقاييس!A2:F13` and historical reviews | Preserve their dates, account and missing-evidence qualifiers. Begin new wallet observations with explicit account/source coverage; do not overwrite earlier metrics. |

`ابدأ هنا!B26:C27` already directs future trading to MetaMask. Update the next-step/current-delivery summary only after the actual implementation and verification are recorded. Fixed-rule automation and proposed strategy improvement remain distinct.

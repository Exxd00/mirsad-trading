# Continuation checkpoint — MetaMask strategy migration

Local source migration requested by the owner on **8 November 2026**: retain the Sheet's `mirsad-ema-15m-v1.0.0` rules and use MetaMask exclusively. This replaces the previous broker integration instructions. It does not authorize resetting historical balances, deleting trades or treating an account read as spending permission.

## Provenance

The Sheet's `ابدأ هنا!A15:C15` selects the strategy version; `إعدادات الاستراتيجية!A1:F24` records its rules. The older guide and improvement baseline contain `percentage-v2` and must not override it. See [wallet-migration.md](docs/wallet-migration.md) for the exact stale ranges and remaining work.

The last reconstructed production checkpoint is **7 November 2026, annex 20:12 Europe/Berlin**: the saved choice selected MetaMask, but redeployment was waiting for the owner's Vercel identity check and the site's effective choice had not been verified. The recorded account connection was a read on Ethereum chain 1. This is dated evidence, not today's live state.

## Current implementation boundary

- Strategy identity: `metamask-strategy-v1`; preserve numerical EMA, allocation, exposure, protection and daily-loss rules.
- The Base Sepolia pilot is a separate exact-swap transport test. Its grants, journal, assets and receipts must not be adopted by the strategy.
- Production strategy transport is incomplete until it proves approved chain/account/token mapping, authentic limit/cancel-60-second semantics, finalized fills, EUR valuations, costs including gas, source coverage and protection.
- Entries stay disabled whenever that contract is absent or incomplete. A typed adapter or green isolated test is not evidence of a live wallet connection.

## Remaining work

1. Finish and independently verify the wallet execution contract in [wallet-execution.md](docs/wallet-execution.md).
2. Obtain explicit chain, token mapping, funding and time limits before any financial delegation; never request a seed phrase or owner private key in chat.
3. Verify deployment identity, exact source revision and existing scheduler configuration. No deployment, scheduler change, trial or financial cycle was performed by this documentation change.
4. Revoke the old external key at its issuer and separately verify deletion of obsolete stored credentials through an explicit migration. Neither production deletion nor external revocation is proved here.
5. Reconcile the Sheet's current instructions without overwriting historical trades, metrics, source events or task history. The existing daily review remains 05:00 Europe/Berlin; do not create another task.

## Storage and history

Keep `reports/**` and historical database rows with their original provenance. Do not rename historical account keys, copy old balances into wallet state, delete Durable Objects or reset performance baselines. The wallet protection object is `mirsad-protection:metamask-strategy-v1`; old objects are archived identities, not new wallet protection.

Preserve the existing production database, encryption key and source event identifiers. [VERIFICATION.md](docs/VERIFICATION.md) defines the evidence still needed before claiming readiness.

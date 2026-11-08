# مرصاد | Mirsad

Mirsad is a private Arabic workspace for the owner's MetaMask account. The active strategy remains **`mirsad-ema-15m-v1.0.0`** with the rules recorded in the Mirsad Sheet. Changing the execution connection does not authorize changing the strategy, seeding a balance or adopting historical positions.

The wallet strategy is **not ready for unattended real-money trading**. It requires a complete wallet transport that proves the existing limit-order and cancellation contract, EUR valuation, market mapping, actual costs and protection. Missing capabilities or evidence must keep entries blocked. A successful build, account read or scheduler response does not prove trading readiness.

## Execution boundaries

- `/wallet` reads the selected MetaMask account and chain. A browser read grant is separate from a spending delegation.
- The existing offline transport pilot supports test USDC/WETH on **Base Sepolia, chain 84532**. It alternates pre-approved swaps to test transport and recovery; it is not the EMA strategy or evidence of profitability.
- The strategy uses the isolated account identity `metamask-strategy-v1`. Its source contract is documented in [wallet-execution.md](docs/wallet-execution.md).
- There is no supported fallback to a previous broker, public-market feed or fee schedule. Paper discovery must report an unavailable source until an independent supported market adapter exists.

## Rules and continuation

The authoritative references are [the Mirsad Sheet](https://docs.google.com/spreadsheets/d/1I4sXWpg5oImDvuXVm0yw4tX_Rg6MpXs4zV38zx1_3RA/edit), `ابدأ هنا!A15:C15`, `إعدادات الاستراتيجية!A1:F24`, and [config/execution-v1.json](config/execution-v1.json). The older `percentage-v2` and `candidate-v3` material is historical.

Read [the strategy contract](docs/execution-core.md), [the migration checkpoint](docs/wallet-migration.md) and [HANDOFF.md](HANDOFF.md) before continuing. Deployment and signing are separate actions; this source migration does not perform them.

## Local verification

Use Node.js 22 or later and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
```

Use the existing database and secrets. Production requires durable Postgres via `DATABASE_URL`; local PGlite is for development. Keep `ENCRYPTION_KEY` unchanged over existing encrypted data. Environment names are listed in [.env.example](.env.example); never put secret values in Git, client code, logs, screenshots or the Sheet.

## Administrative password recovery

`INITIAL_PASSWORD_HASH` seeds a missing owner only; changing it never replaces an existing password. An authorized production recovery can run `pnpm exec tsx scripts/reset-owner-password.mts` as an explicit, one-off server build step. It is separate from normal authentication, application startup and the normal build command.

Supply `MIRSAD_OWNER_RESET_HASH` as a Secret containing the existing scrypt format, a unique UUID in `MIRSAD_OWNER_RESET_ID`, and the independently verified public reporting-key SHA256 in `MIRSAD_OWNER_RESET_EXPECTED_PUBLIC_KEY_SHA256`. The script requires the production environment, the application origin and an existing Postgres owner. It verifies database identity before updating the owner, revoking sessions and recording an audit event in one transaction. Never put a password or its hash in a command argument or source file.

The database commit precedes any subsequent application build: a later build failure does not undo the password change. Retry the same operation UUID and hash to obtain an idempotent result without restoring an older password or revoking later sessions. After verifying login, remove or clear the temporary reset variables and deploy the same source with the normal build command. Update the production bootstrap hash separately if future owner initialization should use the new password.

## Historical evidence

Existing database history and `reports/**` remain historical evidence with their original source, account, timestamps and costs. They are not a wallet balance, wallet performance sample or permission to trade. The migration does not reset those records or transplant their identifiers into wallet state.

Removing source integration code does not revoke an issued external API key. External revocation and production credential purging have **not** been verified by this local change. See [wallet-migration.md](docs/wallet-migration.md).

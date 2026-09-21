# مرصاد | Mirsad

Private Arabic RTL manual trading workspace for a single owner. Official Revolut X crypto integration is being implemented; IBKR is a separate connection and may require a persistent locally authenticated gateway. This application does not make investment decisions.

**Build checkpoint: not yet deployed or broker connected. Live trading is locked.**

## Development

Node.js 22+ and pnpm. Run `pnpm install`, configure the variable names listed in `.env.example` using an ignored `.env.local`, then `pnpm db:init` and `pnpm dev`. Never put a plaintext password or broker secret into a tracked file. Local PGlite storage is development-only; Vercel requires a durable Postgres database.

Run `pnpm test`, `pnpm typecheck`, and `pnpm build` before deployment. Tests must use isolated simulation and must never submit a real financial order.

## Delivery state

See [the consolidated requirements ledger](docs/REQUIREMENTS.md) and [HANDOFF](HANDOFF.md) for completed work, unresolved dependencies, and next steps. See [broker documentation](docs/BROKERS.md) for supported API contracts and limitations.

## Server environment names

- DATABASE_URL
- INITIAL_PASSWORD_HASH
- ENCRYPTION_KEY
- APP_ORIGIN
- LOCAL_DATABASE_PATH (local development only)
- IBKR_BRIDGE_URL (optional; not configured)
- IBKR_BRIDGE_TOKEN (optional; not configured)

No secret values belong in this document. Use separate preview storage and credentials; a preview must never silently inherit live brokerage access.

# Execution core 0.1

The owner's `Educational-Execution-Core-0.1(2).zip` is adapted to this repository's
Node/TypeScript runtime in `src/lib/execution/engine.ts`. There is one current
automatic execution engine. No Python process is assumed inside a Next.js route.

## Current state

- `/automation` and authenticated `GET /api/execution/report` show the new core.
- The owner selected **Mirsad's existing educational account**. Its source
  connector in `src/lib/execution/education-account.ts` reads `education:state:v1`
  from the existing database. It never selects Revolut credentials or the
  separately seeded `simulation:balances` wallet.
- Reports expose the saved balances, positions, orders and metrics with their
  original timestamp. Missing accounts remain uninitialized; invalid data or
  database failures are not replaced with generated zeroes or starter balances.
- The source-to-core mapping preserves available/reserved quantities, quote age
  and prior levels. Existing holdings remain unmanaged by the new core.
- **Source connection is implemented; order execution is not activated.** A
  documented entry-signal source and an execution adapter meeting the five
  guarantees below remain required. These are separate from reading the account.
- Authenticated `POST /api/execution/run` evaluates the available source and
  returns HTTP 409 with its blocker (for example `no_entry_signal`,
  `stale_source` or `education_account_not_initialized`); an HTTP body cannot
  enable execution. No account records are written by this connector.
- The former education, Cloudflare monitor and paper-research engines and their
  execution entry points were removed. Old `/api/education/*` actions return 410
  after site deployment; even signed legacy ticks cannot run the former engine.
- The Cloudflare config has no cron triggers and points to an inert retirement
  worker. Updating Git alone does not redeploy an already running Cloudflare
  worker: redeploy `automation/wrangler.jsonc` to remove its installed triggers.
  No external scheduler deployment or account mutation is performed by this PR.
- Existing stored records and database migrations are retained. The owner-selected
  educational account is read directly, without resetting or copying it to another wallet.

## Preserved policy

10% of available EUR including entry fees; 5% after two consecutive losses or
drawdown >= 2%. Stop 2% and target 4% relative to actual fill price. Existing
positions keep their source-recorded levels. Exits precede entries and only
available quantities of managed positions can be sold. There is one intent per
cycle, no arbitrary daily trade cap and no entry on an already held symbol.
Snapshot and signal age must be between 0 and 300 seconds.

## Adapter contract

Implement `Adapter` using the selected provider's documented API. Times are UTC
epoch seconds; monetary values and quantities are decimal strings. `snapshotSchema`
defines the full boundary. Null risk data blocks entries. Boolean strings are
rejected rather than interpreted as approval. The account ID must match capabilities.

All five capabilities must be **implemented and tested**, not just set to true:
`idempotent_orders`, `atomic_execution_lock`, `fee_inclusive_budget`,
`attached_exit_levels`, `persistent_order_lookup`.

- `claim`/`release` own a durable, account-wide execution lock shared with every
  process. The adapter must renew/fence its lease and reject writes after loss
  of ownership. An in-memory lock is insufficient.
- `order_by_key` and `submit` use the same persistent provider idempotency key.
  Timeouts are unknown outcomes; reconcile them before another snapshot/intent.
  Neither rejection nor cancellation silently produces a different order key.
- `submit` revalidates account, current quantities, tick/lot size, fees, funds and
  lock ownership. Entry cost must not exceed `total_budget_eur`. Attach protection
  to actual fills; reconcile partial fills and remaining protection at the provider.
- `record` is an audit log, never an account ledger. `submitted` only means a
  response to submission; `reconciled` only means a stored order was found. Neither
  status asserts a fill. Terminal rejected/cancelled orders return `blocked` and
  require a documented resolution; the core does not blindly retry them.
- As in the supplied core, **any** item in `pending_orders` blocks all new intents.
  Persistent protective orders need an explicitly reviewed provider mapping;
  do not hide unresolved orders or claim this integration is already ready.

Once the provider integration and signal source are actually ready, replace the
unconfigured host and test its durable concurrency/reconciliation guarantees.
Never run the former and new engines on the same account concurrently. The
original percentages are configuration supplied by the owner, not a profitability
claim. Attached stops do not guarantee execution at their trigger price.

## Verification

`pnpm exec vitest run tests/execution-core.test.ts tests/execution-integration.test.ts`

`pnpm typecheck` and `pnpm build` validate integration with the site. Unit-test
fixtures are test-only and are not balances or provider adapters used by the app.

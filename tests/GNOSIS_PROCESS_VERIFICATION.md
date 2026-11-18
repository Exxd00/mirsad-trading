# Isolated Gnosis process recovery verification

Run with the existing project dependencies; no installation or service is needed:

```powershell
node node_modules/vitest/vitest.mjs run --config vitest.gnosis-recovery.config.ts
node node_modules/typescript/bin/tsc --noEmit
```

The parent test starts isolated Node/Vitest processes with a minimal environment
and a temporary disk PGlite database. The first process constructs the real
chain100 source through the production factory, verifies a synthetic authority,
submits a synthetic partial BUY, persists protection and a pending cancellation,
and waits with its database open. The parent forcibly terminates that OS process
with SIGKILL (TerminateProcess on Windows). A new process opens the same database
without re-seeding application rows, completes cancellation, sells exactly the
confirmed acquired amount, and reconciles fees and PnL. A third process opens
the completed state and checks that repeated host/protection calls do not add
orders, fills, expenses or closed trades. A separate negative scenario changes
the token implementation and requires rejection before any order/broadcast.

Only the RPC, CoW HTTP, scheduler acknowledgment and market-reference port are
synthetic external boundaries. The fake world is serialized independently of
application storage so its chain/order history survives the killed process.
Every unmodeled fetch/RPC fails; Socket.connect is blocked as a second barrier
against real TCP. Ephemeral test keys and synthetic authorization are unrelated
to production credentials; no app environment file is copied into the test.

This covers real application parsers, chain100 identities, signed UID/domain,
authority verification, cost/risk guards, SQL journal, nonce recovery, partial
fill protection, cancellation, managed exit and fee/report deduplication.
It does **not** execute EVM bytecode or certify GnosisMarketClient/oracle/pool
history, liquidity, Worker/DO uptime, deployed protection, a real wallet grant,
live trading, realized profitability or Windows shutdown readiness.

Temporary fixture storage is removed only after verifying its resolved path is
a direct child of the system temp directory with the test's own prefix.

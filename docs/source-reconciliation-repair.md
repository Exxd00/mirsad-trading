# Source reconciliation repair — 2026-10-01

The execution account reader used order-history summaries, while the report
reader retrieved full order details. When a summary omitted a base-currency fee
already included in a saved protection record, the engine treated the missing
fee as a reduction in exited quantity and threw `managed_exit_fill_mismatch`.

Entry checks and reports now hydrate managed filled orders from their durable
source IDs before calculating positions. Identity, timestamp, filled-quantity,
and saved-protection regression checks remain in force. Orders outside the
default history window are re-read, and unavailable or mismatched details fail
closed. Reads do not rewrite decisions, protections, balances, or runtime switches.

The same current order/fill reconciliation now guards the entry account path as
well as the reporting path. A price discrepancy, incomplete fill coverage, or
failed fill read prevents a new entry and invalidates unconfirmed net results.
The strategy cycle also stops before any strategic buy or reverse-cross sell
when this evidence is conflicted or unavailable, including after a later reread.
The separate protection-only path and its existing trigger levels are unchanged.

The broker adapter retains `filled_amount` as `filledAmount`. The report exposes
it alongside the sum of fill quantity × price and their quote-currency difference.
These fields are diagnostic evidence, not permission to silently reconcile a
price conflict. Neither a small monetary difference nor an apparent fee rounding
pattern establishes the broker's rounding policy. Existing fee thresholds remain
unchanged.

Contract references, checked 2026-10-01:

- [Revolut X API](https://developer.revolut.com/docs/api/revolut-x-crypto-exchange)
- [Official order-field interpretation](https://github.com/revolut-engineering/revolut-x-api/blob/master/skills/revx-account/SKILL.md)

Verification uses injected broker transports and an in-memory database. It covers
omitted summary fees, missing history rows, missing/regressed or mismatched full
details, unavailable fills, and blocking the entry planner on contradictory fills.
No real order submission or cancellation is a verification step.

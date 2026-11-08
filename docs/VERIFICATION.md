# Verification boundary — wallet migration

This source migration does not itself prove a production deployment, current wallet connection, active delegation, scheduler health, executed trade or profitable strategy.

## Local checks

Run the project's isolated tests, TypeScript check and production build after the complete source change. Record the actual results in the delivery; old test totals are historical and must not be presented as this migration's checks.

Existing test coverage includes sequential EMA, signal identity, sizing/exposure, transfer-neutral risk, partial-order cancellation, uncertain-outcome reconciliation, protection and honest metrics. The Base Sepolia fixture proof uses artificial prices and an isolated local chain.

## Required wallet acceptance

1. Bind approved chain, owner, tokens, market data and quote currency; reject changed identity and stale or incomplete evidence.
2. Prove a real limit order and cancellation of only its unfilled remainder after 60 seconds. An immediate swap with a deadline is insufficient.
3. Persist identity before submission; recover an accepted transaction after a lost response without duplicate spending; require canonical finalized transfers.
4. Attribute entry/exit execution fees, approvals and gas once, including failed transaction gas; preserve EUR valuation provenance.
5. Reconcile holdings and transfers, verify 10%/5% allocation, three-symbol capacity, 30% exposure, stop/target and daily-loss latching.
6. Verify independent protection, duplicate wakeups, pause, expiry and revocation while preserving already-prepared transaction reconciliation.
7. Verify no calls to the retired service and no import of historical account state into `metamask-strategy-v1`.

## Separate external checks

Compare the deployed revision with reviewed source. Verify existing scheduler cadence and access without creating a second engine. A healthy HTTP endpoint alone does not prove a completed cycle.

External key revocation and deletion of obsolete encrypted credentials in production need separate evidence. A local purge script or source-code removal proves neither. Preserve historical trades and reports.

A first testnet buy/sell pair validates transport only. Real-money readiness requires the complete strategy contract; profitability requires sufficiently complete actual outcome evidence after costs.

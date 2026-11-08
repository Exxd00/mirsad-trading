# Typed wallet strategy transport

Account: `metamask-strategy-v1`. Strategy: `mirsad-ema-15m-v1.0.0`.

This is the acceptance contract for the main wallet strategy. The normalized types in `src/lib/execution/v1/source-model.ts` and adapter in `wallet-venue.ts` are not themselves a working chain transport. Missing implementation or evidence must leave the production factory unconnected and entries blocked.

## Approved identity and source mapping

Bind each source response to the approved chain ID, owner address, strategy account, token contract addresses, decimals and market. Persist that binding across restarts; reject changed chains/accounts and conflicting identifiers. A ticker name alone cannot identify a token.

Use one documented candle source with 1,000 contiguous completed 15-minute bars and fresh executable quotes. The source identity must match the approved mapping. Replacing the removed provider with empty invented candles, another provider's prices or testnet prices is invalid.

EUR remains the strategy accounting unit. The transport must evidence spendable quote funds, documented EUR conversion, reservations, holdings, equity and before/after-flow valuation. USDC, USD and EUR cannot be interchanged at an assumed 1:1 rate.

## Required execution semantics

- A buy is a limit order at the planner's approved price and quantity. Prove actual order identity, status, fills, remaining commitment and supported downward quantity rounding.
- A durable cancellation is armed before entry. At 60 seconds cancel only the strategy's unfilled remainder, reconcile any racing fill, and keep confirmed quantity protected.
- An immediate AMM swap with a minimum output or transaction deadline is not that limit-order/cancellation lifecycle. Remain blocked until the actual contract is supported.
- Sell only confirmed strategy-owned, available quantity; preserve manual holdings and unrelated reservations. Stop, target and reverse-cross exits must be coordinated with pending entries and persisted protection.
- Persist intent and transaction identity before broadcast. Reconcile network uncertainty under the same identity. A timeout, empty lookup or successful HTTP acknowledgement is not a terminal order result.
- Require canonical finalized receipts and matching net token transfers. Retain transaction hash, block identity/time, token quantities and costs. Reorganizations and conflicting duplicate evidence block certification.

## Costs, risk and authority

Document trading fees, expected price impact, spread, approval/execution gas and failed/reverted transaction gas. Reserve enough funding without treating the separate gas signer as owner trading capital. Attribute each cost once with dated EUR conversion. Missing or stale cost evidence prevents entry; the unchanged 0.4% round-trip cap still applies.

Verify full order/fill/transfer coverage, 10%/5% allocation, three-symbol capacity, 30% exposure and the 1% Berlin-day loss latch using the existing risk code. Do not reset drawdown or copy a historical baseline to make the wallet appear ready.

A real-money delegation must bind the approved chain, owner, executor, allowed contracts/tokens, recipient, per-order/aggregate caps, use and duration limits and revocation. The pilot's exact fixed-amount grants are not general authority for dynamic EMA orders. Presence of a signing method or function is insufficient evidence of safe execution capability.

## Acceptance evidence

Use isolated transport tests for changed mapping, stale data, repeated wakeups, lost responses, partial fills, cancellation races, finality conflicts, missing FX/fees, gas exhaustion, expiry, pause and revocation. The independent testnet proof must keep test balances and source records distinct from real account state.

Before any readiness claim, separately verify the deployment revision, existing scheduler, actual grant scope and network receipts. No deployment, delegation, test cycle or scheduler activation is performed by documenting this contract. See [wallet-migration.md](wallet-migration.md).

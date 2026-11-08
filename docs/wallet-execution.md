# Typed wallet strategy transport

Account: `metamask-strategy-v1`. Strategy: `mirsad-ema-15m-v1.0.0`.

This is the acceptance contract for the main wallet strategy. The normalized types in `src/lib/execution/v1/source-model.ts` and adapter in `wallet-venue.ts` are not themselves a working chain transport. Missing implementation or evidence must leave the production factory unconnected and entries blocked.

## Approved identity and source mapping

Bind each source response to the approved chain ID, owner address, strategy account, token contract addresses, decimals and market. Persist that binding across restarts; reject changed chains/accounts and conflicting identifiers. A ticker name alone cannot identify a token.

New entries use the owner's saved `wallet:strategy:watchlist`, intersected with approved market mappings and any nonempty configured symbol restriction. A missing or empty watchlist permits no new entries; it never expands to every approved market. Removing a symbol does not remove protection or exits for existing strategy-managed positions.

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

## Candidate connection implementation — 8 November 2026

The existing strategy, sizing, risk, journal, reporting and scheduler remain the
authority. The following new pieces prepare the missing connection; they do not
install a production source or make the account financially ready:

- `wallet/strategy-profile.ts` stores explicit chain/owner/executor/token mappings
  and methodology references with revision compare-and-set. Every profile remains
  inactive configuration and its authority remains unverified after a restart.
- `wallet/cow-order.ts` commits the GPv2 Ethereum domain and all order fields to a
  deterministic 56-byte UID. `cow-api.ts` only reads version/order/fill/quote data
  from the official endpoint. A 404 is unknown, API fills are not finalized chain
  evidence, and a gas-cost estimate is not an owner's paid transaction fee.
- `wallet/cow-policy.ts` builds an **unsigned** candidate delegation and calldata.
  `contracts/CoWOrderEnforcer.sol` is an **undeployed integration candidate** for
  exact owner-received presigns and cancellation of that grant's registered UIDs.
  It binds canonical app-data to the signed namespace, delegation and intent;
  one intent cannot acquire another UID. Per-order and lifetime raw-token caps
  and conservative price floors bound authority. These are not replacements for
  the strategy's 10%/5%, EUR valuation, exposure, daily loss or cost checks.
- `wallet/strategy-setup.ts` and the owner-authenticated read endpoint show current
  selections, historical selections and stored configuration separately. Previous
  symbols are not copied or silently mapped to wrapped tokens on another chain.

Order validity and the cancellation timer are separate. The production orderbook
requires a minimum validity window at acceptance, so setting expiry to the
decision's 60-second deadline can fail after network latency. A longer permitted
expiry does **not** replace arming the existing durable active cancellation at
60 seconds before sending an entry. Racing fills still require reconciliation.

Revoking a MetaMask delegation does not erase an existing CoW presign. Before a
revocation flow can claim all standing orders stopped, the owner must invalidate
and reconcile the open UIDs (or establish their expiration), and review remaining
token allowances. The executor must never restore a presign the owner cleared.

The local policy tests deploy the real packaged DelegationManager and EIP-7702
implementation on loopback with generated keys. Their settlement is an artificial
fixture, not the live GPv2 settlement. They prove scoped permission and rollback,
not live trade fills, fees, liquidity, 60-second delivery, FX, funding or finality.
No owner funds, keys, real delegation, contract deployment or market order are
used by those tests.

Primary integration references:

- [Pinned orderbook API schema](https://github.com/cowprotocol/services/blob/c1e29b8b5135d5ca600b501a50b6cae4c203aa35/crates/orderbook/openapi.yml)
- [Minimum validity validation](https://github.com/cowprotocol/services/blob/c1e29b8b5135d5ca600b501a50b6cae4c203aa35/crates/shared/src/order_validation.rs)
- [GPv2 signing and persistent presigns](https://github.com/cowprotocol/contracts/blob/main/src/contracts/mixins/GPv2Signing.sol)
- [Canonical app-data schema](https://github.com/cowprotocol/cow-sdk/blob/main/packages/app-data/src/schemas/v1.3.0.json)

The remaining production gate includes approved market mappings, deployed-policy
identity, finite allowances, actual authority verification, finalized transfers,
complete market/FX/history evidence, durable prepared transaction identities and
the concrete strategy-source bootstrap. Until those pass, entries stay blocked.

# Typed wallet strategy transport

Account: `metamask-strategy-v1`. Strategy: `mirsad-ema-15m-v1.0.0`.

This is the acceptance contract for the main wallet strategy. The normalized types in `src/lib/execution/v1/source-model.ts` and adapter in `wallet-venue.ts` are not themselves a working chain transport. Missing implementation or evidence must leave the production factory unconnected and entries blocked.

## Approved identity and source mapping

Bind each source response to the approved chain ID, owner address, strategy account, token contract addresses, decimals and market. Persist that binding across restarts; reject changed chains/accounts and conflicting identifiers. A ticker name alone cannot identify a token.

The owner explicitly selected automatic opportunity selection on 8 November 2026. The versioned `wallet:strategy:selection:v1` setting records `opportunities` or `manual` separately from the watchlist. Automatic mode draws candidates only from the installed execution source's mapped markets after its current grant is verified, intersected with any nonempty configured symbol restriction. Missing, expired, revoked or changed source authority yields no candidates; paper discovery and an inactive profile never supply this universe.

The unchanged EMA and risk checks determine eligible entries. Existing `rankEntries` ranks by estimated round-trip cost, then signal time and symbol; it does not claim to maximize expected return. The runner rotates candidates within its scan budget and creates at most one entry per cycle. Automatic mode does not promise that every market is scanned in one cycle.

A missing selection policy retains manual behavior for existing installations. Manual mode uses the owner's saved `wallet:strategy:watchlist`, intersected with the verified mapped universe and configured restriction; a missing or empty list permits no new entries. Removing a symbol or disabling entries does not remove protection or exits for existing strategy-managed positions.

Saving either selection mode is authenticated configuration only: it does not install a source, grant authority or enable entries. Selection edits share the financial account lease and reject unsettled source writes. The venue rechecks the current selection under that lease before claiming a new buy, so an old prefetched list cannot override a later saved choice.

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

## Mainnet adapter and owner handoff (9 November 2026)

The source now boots on the existing execution host from a versioned owner
profile and encrypted server gas signer. No deployment, page read, wallet
connection or saved selection arms trading. The owner uses `/wallet` to prepare
setup, review the exact contract/limits, deploy the pinned enforcer, request the
MetaMask atomic-account upgrade and finite approvals, verify finalized receipts,
and sign the scoped delegation. `/automation` performs fresh readiness checks
before its existing execution switch can arm entries.

Funding is physical mainnet USDC. EUR is a dated valuation, never a manufactured
balance. Capital covers only the approved ERC20 tokens; native ETH funds gas and
is excluded from capital. Actual owner/executor gas, including reverted actions
and owner setup/closure, is a separate finalized expense. Solver settlement gas
is not charged to the owner. A verified first external deposit starts the return
index after an evidenced empty period; a later wipeout cannot reset losses.

The reference candles use explicitly pinned Coinbase Exchange EUR products.
Exact Ethereum contract matching is mandatory. Canonical WETH9 uses the declared
native ETH redemption reference; this is a reference methodology, not a claim
that Coinbase executes the wallet order. Sparse candle histories are excluded.
The source requires 1,000 contiguous completed 15-minute bars without gap fill.
Entry ranking and the final pre-claim check use verified, exact-quantity CoW
buy/sell quotes. Token fees are embedded in net prices, with a separate bounded
two-nonce gas reserve per leg. A reduced-size budget cannot reuse a larger
order's average fee estimate. The existing 0.4% cap remains unchanged.

CoW-reported aggregate network plus protocol fees are joined by exact UID and
canonical totals, then marked at the last finalized fill's completed EUR minute.
The report names this order-level recognition method and its raw token amount,
rate and timestamp. The public API does not prove total fees per historical
fill; no proportional payment-time allocation or invented zero is supplied.
Net cash PnL uses actual token deltas at each fill's own historical reference.
The reviewed orderbook version is pinned for fee classification. Every indexed
canonical trade must have the non-null attribution coverage sentinel that its
reviewed database transaction commits with total fees. This solver-gas field is
coverage only and never becomes an owner expense. Missing attribution, changed
versions and conflicting totals leave the breakdown unknown. The report does
not claim to independently prove the provider's internal fee formula; actual
net owner cash movements remain the authoritative all-cost PnL basis.

Unsigned intent, UID, encrypted signed raw bytes, nonce and replacement lineage
are persisted before any broadcast/publication. Fresh authority fences run
before signing, broadcast and publication. An intent proven never signed or
posted can become terminal absent; uncertain transmitted bytes retain their
identity. A non-tail unused nonce gap blocks entries until resolved. Old grants
remain separate read-only history readers after renewal; they cannot publish or
reinterpret an old UID under a new delegation.

The proposed grant is finite for seven days. Per-buy ceiling is 10% of initial
USDC; cumulative presigns are capped at ten times initial USDC and are not
refunded by cancellation. Runtime 10%/5% sizing, three positions, 30% exposure,
EMA and Berlin-day 1% halt remain engine rules. Signed price bounds allow at most
twice the initial buy price and impose a half-initial-price sell floor. An entry
whose original 2% stop is outside that scope is rejected. Expiry, missing gas,
price-floor restrictions, unavailable data and chain finality can block work;
there is no guarantee of an immediately executable stop or perpetual authority.

Closing durably fences new authority/actions, invalidates every tracked standing
UID in bounded batches, disables the delegation and zeroes allowances, with
canonical verification. Managed assets remain the owner's assets. Renewal
requires authoritative terminal orders and flat managed positions; it preserves
physical identity, capital history, prior grant configurations and actual fees.
No live owner transaction or trading grant is established by local tests.

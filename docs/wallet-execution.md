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

## Independent EMA market measurement (15 November 2026)

The five-minute execution tick also runs a bounded reference-market observer,
independently of the account/grant and the daily financial report. It uses the
existing official CoW Ethereum token-list/Coinbase metadata intersection and the
same completed 15-minute candles, 1000-candle warmup and EMA 20/50/200 strategy
calculation. USDC is excluded from entry-market observations. This observer
neither installs an execution source nor creates financial signals or intents.

Observations have separate versioned state and a fenced lease, a 300-second
throttle, a 20-second network budget, two concurrent market reads and at most
ten markets per pass with fair rotation. Each scope includes the exact token,
chain, reference product and mapping digest. A changed scope must warm up again;
incomplete, stale or unavailable evidence retains its dates and visible errors.
After an outage longer than the provider's 1000-bar range, only this reference
observer starts a fresh complete warmup; it never resets financial history.
Cached report reads do not trigger scans. Both `GET /api/execution/measurement`
and the manual `POST /api/execution/measure` require the existing authentication;
the latter also requires mutation/CSRF protection and accepts only an empty body.
The stored trigger distinguishes scheduled work from a manual scan; a browser
payload cannot label itself as a scheduler run.

The automation page presents these observations separately from the financial
cycle and performance. Its manual measurement action cannot enable trading or
submit an order. The older discovery-paper assumptions and journal remain
independent. A successful market observation does not certify order execution,
funding, costs, delegation, fills or profit.

The production order publisher shares the same fresh authorization guard with
the protocol execution layer. This includes rereading the durable authority
after asynchronous verification; a closing, changed or expired authority cannot
be accepted from an earlier snapshot. Connecting this guard creates no grant
and changes no execution switch.

## Acceptance evidence

Exact-size entry planning must converge with real token and price grids. A buy
quote rounded to physical USDC atoms can consume the whole budget while the
generic planner rounds its EUR limit price upward; repeatedly recomputing the
maximum quantity then loses another tick indefinitely. On a quantity mismatch,
the CoW adapter reserves two physical quote atoms plus the current quantity's
price-grid rounding cost, caps the next quantity downward and requests both
exact-size quotes again. It accepts only an unchanged final quantity passing
the original budget, cost, exposure, signal and signed-policy checks. This is
rounding headroom within the existing budget, not a spending tolerance or an
altered quote. A genuinely unstable quote remains blocked after three attempts.

Use isolated transport tests for changed mapping, stale data, repeated wakeups, lost responses, partial fills, cancellation races, finality conflicts, missing FX/fees, gas exhaustion, expiry, pause and revocation. The independent testnet proof must keep test balances and source records distinct from real account state.

The composed server test exercises the production bootstrap, runner, wallet
adapter, CoW clients, RPC transport, journals and financial report with isolated
SQL storage and synthetic funding. Only external HTTP/RPC/scheduler boundaries
are simulated. Its third-party runtime bytecodes are read-only fixtures whose
hashes match the pinned mainnet manifest; the receipts, fills and balances are
modeled, not independently executed by an EVM or a real CoW solver. This closes
server-wiring regressions without certifying the owner's capital, real-world
gas/finality/fees, liquidity or a production financial cycle.

Order read freshness remains separate from execution event time. Finality-aware
filled orders carry a canonical `lastFillAt`; closed trades use the last
positive exit fill, ignoring zero-fill cancellation reads. Missing or invalid
event evidence cannot fall back to a polling clock. Later detail reads must
retain the same economic fields and canonical fill time while their observation
timestamp may advance. Re-reading a report therefore cannot move a trade into
another period or silently turn missing cost evidence into zero results.

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

### Hosting restoration check (14 November 2026)

Before trusting a restored host, run the anonymous check against its exact
HTTPS origin and intended release commit:

```sh
node scripts/check-host-readiness.mjs --origin https://mirsad-trading.vercel.app --commit COMMIT_SHA
```

The check only reads `/api/release`, refuses redirects, bounds response size
and duration, and reports `402 / DEPLOYMENT_DISABLED` without trying to parse
the provider's plain-text error as a release. A matching release is hosting
evidence only: `financialReadiness` remains `not-certified`. It does not log in,
dispatch a scheduler tick, create a profile, sign or submit anything.

Restoring or moving the host also requires the original Postgres database and
encryption key, correct HTTPS `APP_ORIGIN`, scheduler credentials and report
identity. Outside Vercel, leave `VERCEL` unset so untrusted requests cannot
select Vercel-specific proxy trust. Preserve the production key namespace
(`VERCEL_ENV=production`) until it is migrated explicitly. A hostname change
requires reviewing every scheduler/report destination: changing `APP_ORIGIN`
alone does not retarget the existing Cloudflare Workers. Keep the existing
Durable Objects, account lease, 60-second cancellation, 10-second protection
and 300-second scan; a web-hosting cron is not an equivalent replacement.

The journal history list now validates the returned SQL snapshot directly
instead of re-reading every row. This removes N additional SQL reads for N
historical records; it does not omit history, change financial write fences
or prove that this path caused a hosting quota overrun. Active CPU must be
attributed by project and route before claiming the team-wide cause.

### Asset and cost feasibility gate (10 November 2026)

`/wallet` first offers an authenticated read-only feasibility audit. It reads
native ETH, canonical USDC and MetaMask/M0 mUSD at one Ethereum block and checks
that block hash again after the reads. These are physical balances, not a
complete wallet valuation or a certificate of unreserved capital. Native BTC
has a separate address/network and is outside this audit. mUSD is identified
by its official contract, never by the ticker or an assumed USDC peg.

The audit samples 10% and 5% of the configured quote balance, or mUSD when no
USDC exists. A verified entry fee exceeding the entire 0.4% cost cap is enough
to reject that sample without inventing a sell quote. Otherwise it requests
buy/sell quotes for the same WETH quantity, uses net paid minus net returned
without double-counting embedded CoW fees, and adds the adapter's reviewed
four-nonce gas ceiling with fresh EUR conversion for USDC. This ceiling is not
a measured fee. mUSD has no verified execution adapter; its separate EUR
reference valuation below cannot make it eligible merely because a simulated
conversion is inexpensive. Missing, stale,
unverified or rate-limited evidence stays unknown. A tested WETH sample does
not establish the economics of every possible market.

New setup, authority preparation and signature acceptance repeat the gate on
the server. Blocked setup creates no executor key, profile or authority.
Existing rechecks, receipt reconciliation and closure remain accessible.
An eligible sample only permits preparing a non-active setup; actual entry
still requires available-capital accounting, market history, signal, authority
and the existing per-intent cost/budget checks. One-time deployment, approval,
upgrade and bridge costs remain unestimated by this audit and require their
own review. No transfer, bridge or top-up is proposed as a remedy for an
unproven route.

### Partial-fill net-limit admission (16 November 2026)

The current public CoW `/quote` request has no `partiallyFillable` field, and
the reviewed response builder fixes the returned value to `false`:
[request schema](https://github.com/cowprotocol/services/blob/7ece6a65e4d3c8735f4043ef387f0f423e5ba1d5/crates/model/src/quote.rs#L118),
[response construction](https://github.com/cowprotocol/services/blob/7ece6a65e4d3c8735f4043ef387f0f423e5ba1d5/crates/orderbook/src/quoter.rs#L395).
A single read-only Base quote probe at 21:52:09 UTC confirmed that an explicit
`partiallyFillable=true` request is ignored: HTTP 200 and `verified=true` still
returned `false`. Canonical-format full app-data and its matching hash were
accepted, but that does not change the response's order semantics. The probe
used hypothetical unfunded Base USDC and unsigned research identity values;
it created no wallet profile, authority or order.

The market quotes keep their actual non-partial flag. Compatibility instead
requires a separate `gpv2-partial-net-limit-admission-v1` certificate. The
reviewed, deployed Settlement runtime rounds partial BUY debits down and SELL
credits up. With signed `feeAmount=0`, exact-transfer tokens and owner receiver,
all BUY partials debit at most `sellAmount * totalBought / buyAmount`, bounded
by the signed sell amount. SELL partials credit at least the signed ratio.
The runtime, constructor immutables, embedded Relayer, deployment metadata and
literal Solidity source hashes are pinned in the real EVM test fixture.

The certificate binds the full admission decision, raw amounts, original
BUY/SELL reference evidence, canonical grant/intent app-data, current token
implementation evidence, dated FX and the actual runtime gas limits. It
recomputes the existing planner's fees, spread once, extra slippage and fixed
gas formula and preserves the 0.4% admission ceiling. It does not freeze the
future exit price or change the 2% stop, 4% target or 60-second cancellation.
The certificate is checked at preparation, resumed presign and publication;
the RPC sink runs a synchronous final freshness/deadline guard after awaited
authorization, immediately before sending a presign transaction.

This first proof method supports canonical Ethereum USDC and WETH9 only.
USDC's actual proxy implementation slot and implementation runtime are checked,
as well as proxy/WETH/Settlement identities and canonical block evidence.
The reviewed implementation has standard transfer semantics; the evidence
does not promise that governance can never upgrade it. Unknown token behavior
cannot acquire this proof merely by matching a ticker or proxy runtime hash.
A local transfer-tax negative demonstrates why this restriction is necessary.

The scope is the existing EXPECTED cost admission at the intended size and
frozen reference, not a promise that every eventual partial fill has realized
expenses below 0.4%. Fixed gas can exceed that ratio for a tiny fill, and
protocol fees taken from favorable price improvement can exceed it while
respecting the signed net limit. Actual expenses remain separately measured;
neither signed fee zero nor a gas ceiling is a zero-expense claim.

The factory no longer declares partial pricing unsupported unconditionally.
Every new BUY still needs a valid certificate. Setup eligibility checks current
reviewed token and Settlement evidence plus sample economics, without creating
a signer, profile or grant. Later financial authorization also verifies the
Relayer runtime through the authority environment. Historical inspection,
cancellation, clearance and protective sells keep their existing paths.
The composed positive now uses the real factory and non-partial HTTP fixtures
without a synthetic capability override; changed implementation evidence
produces no financial writes. External chain/provider outcomes are still
simulated in that lifecycle test, so it is not a live financial cycle.

Optional `phaseMaxGas` bounds are enforced by RPC after the existing 20%
estimate margin. A leg reserves the greater of presign/clear costs at their
shared nonce, plus cancellation at the next nonce. The old uniform limit gives
the same two-nonce total. Local full-policy measurements tested 1/3/9-market
ceilings of 350k/210k, 375k/235k and 450k/300k for presign/cancel; these are
tested candidates, not lowered production defaults or future gas-price promises.

The Gnosis public quote endpoint returned a pay-as-you-go quota response during
research. Its unsigned x402 challenge priced quotes at 0.001 USDC/request.
No payment integration or deposit was enabled. Two paid quotes every 10 seconds
would cost 17.28 USDC/day for one market, so that polling model is unsuitable
for the observed small wallet. Free history reads and a separate on-chain
reference-data method must not be relabelled as a firm CoW quote or paid access.

### Gnosis source and chain identity foundation (16 November 2026)

The connector accepts explicit Ethereum (1) or Gnosis (100) identity throughout
the read/submit API, RPC, setup, policy, journal and owner-review UI. This
software capability is distinct from a funded, delegated or armed account. The
public deployment manifest pins chain 100 Manager, 7702 implementation,
Settlement, Relayer, token proxies and implementations using two fixed official
RPC endpoints. These runtimes differ from Ethereum even where addresses match.
USDC.e is bridged USDC; the local WETH is bridged Ethereum WETH, not native xDAI.
No native/bridged asset parity or bridge solvency follows from a matching name.

Order digest/UID, delegation terms/signing domain and custom-enforcer constructor
helpers now support explicit chain 1 or 100. Existing callers default to chain 1;
other values fail instead of selecting a fallback. A local chain-100 EVM test
installs the observed public Manager/7702/Settlement code, deploys the candidate
enforcer and proves exact patched runtime, bounded presign/retry/cancellation
and rejection of Ethereum delegation replay. This does not deploy a real
contract or create an owner grant. Gnosis CoW paths use the published `xdai`
namespace; a missing network on a legacy record means Ethereum only. Requests
and persisted quote identities cannot silently cross networks. Owner wallet
actions snapshot the reviewed account, chain, calldata and expiration before
waiting for the wallet. Network switching remains an explicit owner action.

The independent `gnosis-reserve-state-bars-v1` reader reconstructs actual
15-minute WETH/WXDAI reserve STATE OHLC and actual gross base Swap flow from the
pinned Sushi V2 pool. LP/sync changes affect this price state; it is not a
traded-price OHLC series. No-change intervals retain proven reserve state, never
fabricated transactions or volume. Bounded complete log ranges must match both
RPCs; canonical event headers and baseline/end archive state replay are checked.
The scope explicitly relies on matching RPC coverage rather than receipt-trie
proofs. Actual 1,000-bar RAW reserve-state history passed a read-only source
probe; this alone does not certify the composed EUR history required by EMA.

Only finalized blocks are accepted; there is no latest/unfinalized downgrade.
The five-minute scheduler configuration uses UTC minutes `3-58/5`: this keeps
the 300-second period and allows finalized blocks to arrive before the first
scan after a 15-minute close. Late finality still blocks/misses the signal;
original close time is never restamped. A configuration edit is not evidence
that the existing Worker has been deployed with this phase.

`gnosis-chainlink-underlying-eur-reference-v1` separately validates the published
EUR/USD, DAI/USD and USDC/USD feeds and their pinned proxies/aggregators. It
reconstructs actual transmission-block availability before each requested close,
preserves update times and the published 86,400-second heartbeat, and rejects
phase changes, stale/nonpositive answers, inconsistent identity or coverage.
The source probe verified 1,000 historical points with 92 actual transmissions.
Its DAI/EUR and USDC/EUR values remain UNDERLYING references: native xDAI and
bridged USDC.e spot EUR fields stay null in this isolated oracle reader.

The composed `gnosis-canonical-state-eur-reference-v1` source uses actual
WETH/WXDAI reserve state, WXDAI/USDC.e Uniswap V3 state and the underlying
USDC/EUR feed. Events are merged by canonical block and global log index before
OHLC calculation; independent OHLC extrema are never multiplied. Its explicit
USDC.e unit reference checks the pinned USDCTransmuter, enabled state, exact
token identities and backing. Both RPCs must agree on the complete historical
backing/supply log replay and controls; a temporary shortfall is rejected even
if restored before the end. This is a redemption-unit assumption with bridge
and governance risk, not a claim that bridged assets always trade at a peg.

The closed 15-minute EMA history now has an explicit separate policy,
`gnosis-ema-history-event-grace-v2`. Every open and close retains the strict
86,400-second round-age limit. Only an intrabar event may qualify a short
delivery delay: the immediate next same-feed canonical transmission must arrive
strictly before that bar closes, and its full delivery excess beyond the prior
round's heartbeat must be at most 60 seconds. The earlier event continues to use
the actually available old answer until the ordered transmission occurs. The
successor qualifies the closed bar as of its decision time; its answer is never
backdated. The 60-second ceiling is an engineering policy, not an oracle SLA.
Current prices, minute valuations, provisional fill FX and funding conversion
retain their existing strict checks.

The observed blocking case was an actual WXDAI/USDC.e Swap at block 49262392,
global log 32, timestamp 1794594240. USDC/USD round 73786976294838206587 was
86,405 seconds old. Its immediate successor arrived in block 49262393, log 97,
timestamp 1794594245: a total delivery excess of 10 seconds, within the same
bar ending at 1794594600. Matching reads from the two configured RPC endpoints
establish this example, not a certificate for the remaining 1,000-bar window.

The historical policy has a distinct `gnosis-history:v2:` identity, SQL
namespace and mapping/EMA source identity. Strict v1 capsules are imported only
through validated lineage that retains the original identity, provenance and
per-bar fingerprints with identical candle and mark values. Original evidence
is preserved. Parent quarantine and semantic conflicts remain effective across
imports and cold loads; a different raw contract/feed identity cannot inherit
these old bars. Legacy runtime mappings retain current reads and protective
cancellation/exit access, while new or resumed BUY publication and v2 EMA use
under a legacy identity are blocked. Existing owner-attempt recovery remains
readable. A history-method migration does not reset capital or risk state.

Validated finalized EUR chunks persist in private SQL settings with compiled
source identity, canonical digests and per-bar semantic fingerprints. A
conflicting overlap commits a permanent global quarantine before returning an
error; later reads cannot erase it. SQL limits cumulative JSON bytes before
returning rows. Process restarts preserve chunks and quarantine. Source identity
also binds EMA state; legacy nonempty or mismatched indicators block migration
instead of reusing Ethereum history or resetting capital/performance.

The authenticated, CSRF-protected chain-100 market-readiness POST starts or
resumes a separate data-only job. GET reads stored state only. The existing
five-minute tick may resume an explicitly requested job while the financial
profile is missing; protection ticks never warm 1,000 bars. A 65-second SQL
lease, 300-second claim cadence and owner fence prevent parallel work and late
writes. New jobs have a twelve-hour/144-attempt cap so bounded ten-bar chunks
can cover 1,000 bars plus the advancing window. Existing six-hour/72-attempt
jobs retain their limits on GET/scheduler reads; only an explicit POST upgrades
their policy, preserving the original ID, start, attempts, report, lease and
cooldown. The job schedules its next normal attempt from claim start, not report
completion. An actual provider Retry-After extends that deadline and persists
across restart and policy upgrade. Each attempt budgets 40 seconds for history,
three for stored progress and eight for a fresh current reference. Small
verified chunks survive an incomplete attempt. The UI preserves observation
times and expires freshness locally; reference completeness is expressly not
financial readiness. Full 1,000-bar composed EUR history still requires an
actual successful source probe and is not certified by fixture tests.
Current-policy readiness requires the explicit historical policy and source
identity. Older reports remain displayable but cannot certify v2 freshness.
An active job retains its ID, attempts, lease, cooldown and original expiry;
an already completed legacy job is not silently restarted by resume-only work.

For a newly mined fill, separate provisional entry-protection FX uses an actual
canonical block strictly before the completed minute. The original FX block
and hash are retained across restart and revalidated before latching a stop or
target; final accounting and PnL still wait for finalized evidence. Neither this
reference data nor the preflight creates a balance, executor, grant, order,
paid quote subscription or execution readiness.

The earlier public quote quota response was temporary: a bounded retry at
00:04:36 UTC returned HTTP 200. At 00:05:27–28 UTC, two verified but non-partial
quotes for the same 544792194100668 bridged-WETH atoms gave maximum reference
entry debit 1001073 USDC.e atoms and reference return 998093, about 0.29768%
round-trip loss BEFORE executor gas. App-data was zero research identity and
the owner had no Gnosis funds; this is not a grant-bound admission certificate.
The response's 2-bps protocol fee annotation is already included in adjusted
quote amounts and must not be added a second time. Quote gas estimates are not
owner-executor receipts. Lower-priced actual unrelated transactions establish
historical inclusion only, not a future timeliness or cost guarantee.

Read-only CoW quote requests share a production process gate across networks and
client instances: one request in flight, at most eight queued requests and a
250-ms gap. Queue time counts against the existing five-second read deadline.
HTTP 429 records a retry time before releasing the gate, honors a valid
`Retry-After` and uses an explicit local 300-second cooldown when it is absent
or malformed. Valid future holds are not shortened; an unrepresentable numeric
or recognized-date hold uses a terminal, date-safe hold for that process. Waiting
requests fail instead of being replayed after the hold; there is no automatic
retry. Order/fill reads and transaction submission/cancellation are outside this
quote gate. The 15-second evidence limits and bounded quote calculations remain
unchanged. This coordinates one process, not different Vercel instances or cold
starts, and the local pacing policy is not a provider availability guarantee.
Setup reference sampling reserves one quote-token atom before the preliminary
SELL quote as conservative headroom between independent SELL and exact BUY
references. A nonpositive post-gas seed makes no quote request. Final paid-plus-
entry-gas, round-trip cost, exact quantity and freshness checks remain strict;
this is neither a budget tolerance nor a guarantee that later quotes will fit.
Sampling uses at most three exact BUY references. An over-budget response can
only reduce the positive integer base quantity before a new-size request; the
same-quantity reverse SELL is requested only after BUY plus entry gas fits.
Provider errors stop the sample without a retry. The original seed and FX
15-second evidence bounds remain fixed throughout; resizing does not refresh
them or change the runtime entry planner's attempt limit.

### Owner funding review (16 November 2026)

The authenticated funding route proposes one fixed source-chain input of
10 mUSD on Ethereum for USDC.e on Gnosis. Its 0.05-mUSD GasZip allocation is
included in that input. Approval is exactly 10 mUSD to the pinned LI.FI Diamond;
provider gas/nonce fields and arbitrary targets are not forwarded to MetaMask.
The fixed routes request selects LayerSwap and the reviewed SushiSwap source
exchange explicitly. Among at most three returned routes, the server selects
only a single-step route with the fixed owner, chains, input, GasZip allocation
and a reviewed USDC or native-ETH bridge branch. One unsigned step-transaction
request uses that
exact step. Its returned identity and full calldata must pass the existing
parser before any fresh-chain proof or owner reservation. No matching route or
asset drift fails closed; there is no retry or unreviewed-asset fallback.
For either source-swap route, the bridge action names the
quoted source output; its estimate may name only that exact output or the exact
calldata-enforced source minimum. Other step amounts remain exact. This metadata
compatibility does not relax router pins or the strict final aggregate slippage
minimum, and that slippage bound is not a certificate of total funding fees.
The explicit native branch uses zeroAddress only for the API, outer SwapData,
bridge and deposit event, and the exact Eeee sentinel only inside the pinned
RedSnwapper call. ETH amounts and fees use 18 decimals; mUSD and USDC remain at
six. Combined quoted ETH fees cannot exceed the signed native bridge minimum.
The fixed mUSD fee cap and input stay unchanged. A native source receipt must
match the pinned depository's native Deposited event and actual bridge amount;
an ERC20 Transfer or a balance difference cannot substitute for that proof.
The intermediate ETH is produced inside the swap with owner transaction value
zero. This does not prove eligibility for paying the owner's Ethereum gas.
Existing direct-mUSD and USDC review serialization and digests are retained so
saved owner attempts remain recoverable after adding the separate native branch.
The LayerSwap destination amount is an off-chain quote, not a minimum enforced
by source calldata. Gas arrival and MetaMask Gas Included eligibility/fees remain
unproved until the owner reviews the wallet and destination balances arrive.

Before a reservation, the service requires an actual contiguous 1,000-bar SQL
cache snapshot under the compiled source identity, within 24 hours and outside
quarantine. This initial-history proof is not live entry readiness. Fresh paired
RPC reads check contract runtimes, mutable routing/whitelist state, backend
signature authority, request replay state, balances, allowance and nonces.
The destination snapshot is read last. A 90-second quote review is revalidated
into a short-lived reservation immediately before an explicit owner action.

Private SQL owner locks preserve the exact review, proof and transaction bytes
before any wallet prompt. Hash recording survives UI unmount; unknown requests
have no TTL release and block subsequent funding. A known hash is retained for
recovery if recording fails. A trusted client classification before the wallet
RPC permits an explicit unsent cancellation only after fresh baseline checks.
That classification is an owner attestation, not cryptographic proof of mempool
absence; raw provider errors cannot forge it. Numeric owner rejection 4001 is
handled separately. No passive effect connects, switches or sends a transaction.

Finalized source receipts and exact token/protocol events resolve the stored
attempt, including relayed wallet transactions. Receipt status alone is not
success. A receipt must be mined strictly after the review's already closed
canonical source anchor. A reverted direct owner transaction must also match
the exact call and have a valid nonce at least as high as the reserved pending
nonce; missing, malformed or older nonce evidence leaves the attempt fenced.
The wallet's nonce is not forced. A reverted wrapper without matching action
evidence remains unresolved. A confirmed source transfer does not certify bridge arrival; extra
owner token outflow is recorded without inventing gas attribution. Successful
funding closes this one-off path rather than permitting another transfer.
Trading still requires current feasibility, bounded authority, cancellation
protection and the verified scheduler phase. The assistant does not confirm
wallet prompts or activate financial execution.

### mUSD reference valuation (15 November 2026)

The owner-authenticated, CSRF-protected `POST /api/wallet/strategy/valuation`
reads an Ethereum mUSD balance and provides a separate reference mark. It
creates no executor, profile, grant, financial journal, order or transaction.
The response always retains `referenceOnly=true`, `executionReady=false` and
`createdExecutionState=false`. Missing evidence is unavailable, never a zero
valuation or a replacement for the execution feasibility gate.

The current reference simulates exact-input **mUSD to USDC for the actual
observed raw balance** through the pinned Uniswap v4 quoter using `eth_call`.
It multiplies that size-specific USDC output by the actual Coinbase Exchange
`USDC-EUR` completed one-minute close. Neither mUSD=USDC nor USDC=EUR is
assumed. Inventory is read at a pinned block, and balance and block identity
are checked again at the quote block. A changed balance or conflicting block
leaves the current mark unavailable. The current block is explicitly labelled
`latest-unfinalized`; this is a simulation, not a promised executable output.

Historical reference points use a one-mUSD simulation at the last finalized
Ethereum block at or before the requested minute, no more than 60 seconds
earlier, and the corresponding completed `USDC-EUR` minute. The historical
unit mark does not establish the owner's historical holdings, invested capital
or performance. An archive failure is not filled with today's ratio or a peg.

The [pinned manifest](../src/lib/wallet/generated/musd-reference.json) binds
chain 1, token addresses and six decimals, PoolManager, StateView and quoter
runtime hashes, pool-key hash, token direction and initialization receipt/log.
For upgradeable token proxies, the runtime hash pins the proxy bytecode, not
its mutable implementation; it does not prove current transferability.
The reader checks liquidity, price state, contract relationships and the
canonical block again. Provider, pool, block, exact input/output, liquidity,
price state and completed EUR source identity are included in provenance.
The zero-fee pool key does not certify a free swap or free setup: the quoter's
gas estimate is a unit count, not actual gas paid; `actualExpenseEur` stays null.
Allowances, transferability, CoW liquidity, authority, cancellation and full
cycle costs require their own execution evidence.

Reference work has a 20-second total budget, five-second individual reads,
256-KiB RPC responses and a 96-read cap per attempt. Only current-reference
transport unavailability/timeouts may try the fixed alternate RPC with the
remaining budget; contract/identity failures are not bypassed. Historical
reads use the fixed archive source. Current quotes reject a block over 60
seconds old or an EUR minute over 120 seconds old; the valuation wrapper
rejects results exceeding its 55-second response-age bound and rechecks freshness.

Historical CAS storage is injectable and separate from execution state; the
default client has no persistent storage adapter. It does not establish full
historical coverage or a provider/service availability guarantee. Keys bind the
provider version, chain, pool and minute. Reads validate exact raw amounts,
arithmetic and provenance, then recheck canonical finality. Writes compare
revisions atomically with at most three attempts. A different provenance for
an existing minute preserves the original evidence and quarantines that key;
it is not silently overwritten or adopted as financial history.

### Dated Base cost research; no production adapter

The [15 November public-quote fixture](../tests/fixtures/base-cost-sample-20261115.json)
is research evidence from **21:15:28–33 UTC**, assuming an unperformed nominal
1:1 conversion of existing mUSD into Base USDC. It proves neither conversion
proceeds nor a funded Base balance. Both paired BUY/SELL quotes used exactly
the same WETH quantity, were provider-verified within 2.279/2.081 seconds, and
had gross buy debits inside their respective allocation caps:

| Allocation cap | Actual sample debit / return (USDC) | Net quote cost before extra executor gas |
| --- | --- | --- |
| 10%: 1.080726 | 1.077040 / 1.073556 | 0.323479%; only 0.00082416 USDC remains under the unchanged 0.4% cap |
| 5%: 0.540363 | 0.538625 / 0.534066 | 0.846414%; already above the cap |

These quotes used `presign`, zero `appData` and `partiallyFillable=false`.
They do not certify the production profile's calldata, partial-fill limit
orders, active cancellation after 60 seconds or settlement finality. Net quote
amounts already include their quoted fees; another protocol percentage is not
added again. Additional executor, cancellation/replacement, setup, conversion,
bridge and EUR-conversion costs remain unproven. There is no live Base adapter
or financial action from this research. An expired sample stays dated research;
even a fresh under-cap quote cannot certify financial readiness.

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
Entry ranking and the final pre-claim check require verified, exact-quantity
reference quotes and the independent net-limit admission certificate described
above. The public quotes retain their actual non-partial flag; that flag alone
does not authorize an entry.
Token fees are embedded in net prices, with a separate bounded
two-nonce gas reserve per leg. A reduced-size budget cannot reuse a larger
order's average fee estimate. The existing 0.4% cap remains unchanged.

CoW-reported aggregate network plus protocol fees are joined by exact UID and
canonical totals, then marked at the last finalized fill's completed EUR minute.
The report names this order-level recognition method and its raw token amount,
rate and timestamp. The public API does not prove total fees per historical
fill; no proportional payment-time allocation or invented zero is supplied.
Net cash PnL uses actual token deltas at each fill's own historical reference.
Fee classification accepts only the exact reviewed releases
`v2.386.1@c1e29b8b5135d5ca600b501a50b6cae4c203aa35` and
`v2.387.2@7ece6a65e4d3c8735f4043ef387f0f423e5ba1d5`. The latter was
checked against its atomic attribution/fee save and order total/token query;
this is compatibility with that release, not permission to accept future
versions or an independent proof of the provider's internal fee formula.
The version endpoint returns plain text even with `Accept: application/json`;
its bounded response is parsed separately from order, trade and quote JSON.
Every indexed canonical trade must have the non-null attribution coverage sentinel that its
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

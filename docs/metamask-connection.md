# MetaMask on Mirsad

The owner opens `/wallet` in a signed-in Chrome profile. Connecting the extension displays the selected EVM account, network and native balance. Creating an automatic trial also records the selected address and its limits in the private Mirsad database.

## Buying and selling with the browser closed

The working pilot uses test USDC and WETH on Base Sepolia (chain 84532) and a MetaMask EIP-7702 smart account. On the production site, choose the test network and enter the USDC per purchase, maximum number of rounds, expiry and price tolerance. Review the quoted minimums, total USDC cap, wallet recipient and separate gas address. The owner's wallet signs two typed delegations during setup, one for each direction. The dedicated gas address needs test ETH on Base Sepolia. The smart account needs test USDC for the chosen amount.

Mirsad uses the existing authenticated Cloudflare execution tick. The test job starts independently of the Revolut cycle. The browser, Windows PC and daily 05:00 Berlin review have no role in signing or waking the server. The wallet panel shows the last scheduler check, pending transaction and finalized receipts. The public test pool can move outside the signed price band, in which case the server waits.

Every successful direction executes a fixed atomic batch through the MetaMask DelegationManager. The first call approves the exact input to the fixed Uniswap V3 router. The second swaps into the owner's address with the signed minimum output, and the third clears the allowance. Framework enforcers restrict the entire batch, sender, number of uses and expiration on chain. Each direction has its own signature and counters. The server orders the two legs and starts a sell after a confirmed buy. It sells the signed minimum quantity from that buy. Any excess WETH stays in the owner's wallet.

The host encrypts signatures, the independent test gas signer and pending transaction bytes in its private database. A database row lock serializes preparation. The host saves the signed bytes before broadcasting and reconciles the same hash across restarts. A fill requires a successful canonical finalized receipt and matching net input and output token transfers. “Pause” stops preparation of new submissions. Reconcile any already-prepared hash. The two on-chain revocation buttons invalidate the corresponding permissions and require owner confirmation and test gas.

Production accepts grants only for Base Sepolia. Preview deployments show the controls without accepting grants. Local development uses a separate journal and requires `MIRSAD_WALLET_TESTNET_ENABLED=true`. The setting `false` disables the scheduled trial. The public RPC endpoint defaults to Base Sepolia and can be overridden with `MIRSAD_WALLET_TESTNET_RPC_URL`. The server verifies the chain ID, recent block and the owner's EIP-7702 implementation.

## Live cutover

The trial alternates the exact approved swaps to verify execution. Using the real portfolio requires the owner's chain, token pair, individual and aggregate funding limits, duration, and explicit on-chain authorization. Real entry signals, stop/target handling, gas and fee budgets and account risk reconciliation must be checked on that chain before switching the actual venue.

`MIRSAD_ORDER_CONNECTION` controls the legacy entry route. Unset or `revolut-x` uses the existing route. Selecting `metamask` sends the homepage to the wallet and blocks new Revolut orders, including old order previews and strategy re-arming. Any other provided value also blocks new entries. The legacy report, existing protection watcher and managed cancellation deadlines continue to use their original account. Reconcile current positions and unresolved orders across all live deployments before changing that setting.

The local automated proof uses contract bytecode from MetaMask, a temporary Anvil node and two fixture tokens and a fixed-price fixture router. It signs both grants, drops a submission acknowledgment after the node accepts the transaction, resumes from the encrypted journal, confirms both fills and exercises the on-chain use limit, revocation and expiry. The proof uses artificial prices.

[MetaMask smart accounts](https://docs.metamask.io/smart-accounts-kit/) · [Framework enforcers](https://github.com/MetaMask/delegation-framework/tree/v1.3.0/src/enforcers) · [Uniswap V3 Base deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments) · [Circle USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses).

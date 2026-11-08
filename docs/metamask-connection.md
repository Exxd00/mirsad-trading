# MetaMask on Mirsad

The owner opens `/wallet` in a signed-in browser. Reading the selected account, chain and native balance is separate from authorizing the server to spend. A read connection on Ethereum mainnet (chain 1) is not a Base Sepolia delegation or proof of automated trading.

## Existing transport pilot

The offline pilot is restricted to **Base Sepolia (84532)** with test USDC and WETH. It uses a MetaMask EIP-7702 smart account and two signed delegations, one per direction. Each delegation fixes its atomic approve/swap/clear-allowance batch, recipient, sender, use count and validity period.

The server alternates a buy and sell only after the preceding direction settles. Signed price floors and tolerance constrain each round. Excess WETH above the signed sell input remains in the owner's wallet. This is a transport/recovery test with exact swaps, not an EMA entry/exit strategy.

The independent test gas signer, signatures and prepared transaction bytes are encrypted in private storage. A database row lock serializes preparation. Prepared signed bytes are persisted before broadcast; a lost acknowledgement is reconciled by the same hash. A successful fill requires a canonical finalized receipt with matching input/output token transfers.

Pause stops preparing new submissions. Already-prepared or submitted transactions still require reconciliation. On-chain revocation is a distinct owner-confirmed operation that uses test gas.

Production grants are accepted only for Base Sepolia; previews cannot accept them. Local development requires explicit `MIRSAD_WALLET_TESTNET_ENABLED=true`; `false` disables scheduled pilot work. `MIRSAD_WALLET_TESTNET_RPC_URL` overrides the Base Sepolia endpoint. The transport verifies chain, recent block and smart-account implementation.

The pilot uses the existing authenticated execution tick and does not depend on the owner's Windows computer, open browser or 05:00 review. This describes the source design; live deployment, scheduler state, current grants and successful swaps require separate dated evidence.

## Main strategy

The main strategy retains **`mirsad-ema-15m-v1.0.0`** and uses account identity `metamask-strategy-v1`. The pilot's fixed exact-swap grants cannot silently become dynamic strategy authority.

Before main strategy execution, implement and verify [wallet-execution.md](wallet-execution.md): approved chain/token mapping, stable source history, authentic limit orders with unfilled cancellation after 60 seconds, EUR valuations, documented fees and gas, confirmed fills, exposure/daily-loss controls and independent managed protection. Any missing capability keeps entries blocked.

Do not substitute an immediate swap for the limit-order contract, assume USDC equals EUR, fabricate fill history or import previous account holdings into strategy ownership. There is no supported order route or data fallback to the removed broker.

An operational real-money grant requires the owner's approved chain, token pair, funding caps, duration and explicit wallet authorization. Never request the owner seed phrase or private key in chat. Neither source changes nor browser read access supplies that grant.

## Evidence and history

The isolated proof uses temporary Anvil, fixture tokens and artificial prices. It covers both grants, acknowledgement loss, recovery, use caps, revocation and expiry; it does not prove executable market prices or returns.

Historical reports and database rows retain their original provenance. External API-key revocation, production credential purging and deployment verification are separate remaining tasks in [wallet-migration.md](wallet-migration.md).

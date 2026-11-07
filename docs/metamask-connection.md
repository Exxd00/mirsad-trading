# MetaMask connection on Mirsad

`/wallet` requires the existing owner login. On desktop Chrome it discovers the MetaMask EVM extension via EIP-6963. The owner chooses the account in the extension. The address, selected chain and native balance stay in browser memory. A connection is not a wallet login to Mirsad, proof of ownership, a transfer, trade approval or an unattended signing mandate. There is no wallet key, new domain, database migration or RPC service to buy for this step.

| Server setting `MIRSAD_ORDER_CONNECTION` | New orders | Earlier Revolut activity |
| --- | --- | --- |
| Unset or exactly `revolut-x` | Existing behaviour; visiting `/wallet` does not switch trading. | Existing behaviour. |
| Exactly `metamask` | The homepage leads to the wallet. Manual broker orders (including old previews), strategy runs and re-arming Revolut are blocked; wallet swaps are not implemented. No fallback. | Source reads, daily report, the existing protection watcher and managed cancellation deadlines remain on Revolut. |
| Any other supplied value | Blocked, including on a typo. | Same legacy monitoring. |

## Production handover

1. In the owner's authenticated IXA Chrome profile, reconcile Revolut's open orders, positions, outstanding submissions and protective watches against current source data. Do not treat an old report or conflicting fills as zero exposure. Keep legacy credentials and protection while any obligation remains.
2. Verify the browser extension, chain and account in the owner's profile. Use only **Connect**. There is no transfer from Revolut and no transaction to sign for this check. The wallet balance here is the native asset, not the token portfolio or legacy EUR balance.
3. Before using the setting in production, agree on the desired chain, token pair/router and signing mode. The settings apply per deployment: coordinate the scheduler target and all live hostnames, wait for old in-flight invocations, then recheck outstanding intents and source records. The setting does not drain an old deployment or disarm a pending Revolut order. Do not revert to permissive legacy settings while old live/entry requests are still armed.
4. For real wallet execution build a chain-specific quotation, simulation, exact approvals if needed, fee and slippage limits, transaction reconciliation and protected exits. A standard extension calls for the owner's confirmation per transaction; closed-browser execution additionally needs an explicitly signed, revocable policy bounded by chain, contracts, assets, amounts and expiry. No seed phrase or unrestricted wallet signer belongs on Mirsad. Do not claim a fill before its on-chain receipt and settlement evidence.

Sources: [MetaMask EVM connection](https://docs.metamask.io/metamask-connect/evm/guides/manage-user-accounts/), [EIP-6963](https://eips.ethereum.org/EIPS/eip-6963), [MetaMask transaction confirmation](https://docs.metamask.io/metamask-connect/evm/reference/json-rpc-api/eth_sendTransaction/), [delegation toolkit](https://docs.metamask.io/smart-accounts-kit/).

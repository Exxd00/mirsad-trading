# Source evidence reconciliation

The previous broker-specific repair instructions are retired. Current execution uses the normalized wallet evidence contract in [wallet-execution.md](wallet-execution.md).

Reconciliation must match approved account, chain, token addresses, order/transaction identity, quantities, timestamps and actual fees. Acknowledgement is not finality; an absent lookup following a timeout is not proof that nothing was sent. Preserve unresolved identities and block overlapping writes until source evidence settles them.

Historical discrepancies retain their original records and provenance. Do not rewrite historical prices, infer a missing zero fee or use old account snapshots as the wallet baseline. See [wallet-migration.md](wallet-migration.md).

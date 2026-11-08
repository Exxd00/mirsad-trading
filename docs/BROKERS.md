# Execution connection

Mirsad's current execution scope is **MetaMask only**. The previous broker setup, endpoint and key-registration instructions are retired.

Read [the wallet transport contract](wallet-execution.md), [the unchanged strategy](execution-core.md) and [the migration checkpoint](wallet-migration.md). An incomplete wallet transport must report a blocker; it must not fall back to a retired account or market feed.

Historical reports and stored account records remain evidence under their original identities. Removing the integration does not revoke a key at its external issuer, purge production credentials or transfer historical positions to the wallet.

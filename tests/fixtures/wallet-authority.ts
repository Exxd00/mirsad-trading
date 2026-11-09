import { randomUUID } from 'node:crypto';
import { getAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { CONFIG } from '../../src/lib/execution/v1/model';
import { COW_SETTLEMENT, COW_VAULT_RELAYER } from '../../src/lib/wallet/cow-order';
import { createAuthorityReview, type AuthorityPreparation, type AuthorityVerification } from '../../src/lib/wallet/authority';
import type { AuthorityEnvironment } from '../../src/lib/wallet/authority-service';
export const address = (n: string) => getAddress('0x' + n.repeat(40));
export const hash = ('0x' + 'a'.repeat(64)) as Hex;
export const owner = privateKeyToAccount(generatePrivateKey());
export const NOW = Math.floor(Date.now() / 1000);
export function authorityPreparation(now = NOW): AuthorityPreparation {
  return { terms: { id: randomUUID(), chainId: 1, owner: owner.address, executor: address('2'), quoteToken: address('3'),
    startsAt: now - 60, expiresAt: now + 3600, maxOrderValiditySeconds: 300, maxQuotePerBuy: '10', maxQuoteTotal: '100',
    markets: [{ baseToken: address('4'), maxBasePerSell: '10', maxBaseTotal: '100', buyFloorQuote: '10', buyFloorBase: '1', sellFloorBase: '1', sellFloorQuote: '5' }] },
    contracts: { manager: address('5'), implementation: address('6'), enforcer: address('7'), settlement: COW_SETTLEMENT,
      vaultRelayer: COW_VAULT_RELAYER, release: 'isolated-v1', codeHashes: { manager: hash, implementation: hash, enforcer: hash, settlement: hash, vaultRelayer: hash } },
    block: { number: '100', hash, timestamp: now }, ownerMode: 'eoa',
    allowances: [{ token: address('3'), current: '999', finiteAmount: '100' }, { token: address('4'), current: '0', finiteAmount: '100' }], blockers: [] };
}
export function authorityProfile(now = NOW) {
  const p = authorityPreparation(now), t = p.terms;
  return { schemaVersion: 1, kind: 'owner-strategy-profile', accountId: CONFIG.accountId, strategyVersion: CONFIG.strategyVersion,
    chainId: 1, owner: t.owner, executor: t.executor, quoteToken: t.quoteToken, quoteDecimals: 6,
    markets: [{ symbol: 'AAA-EUR', baseToken: address('4'), baseDecimals: 18, quoteToken: t.quoteToken }], accountingCurrency: 'EUR',
    conversion: { quoteUnit: 'USDC', sourceId: 'isolated-fx-source', methodologyReference: 'urn:mirsad:fx:v1', evidenceReference: 'urn:mirsad:fx:evidence' },
    authority: { grantReference: 'urn:mirsad:grant:v1', revocationReference: 'urn:mirsad:revocation:v1', startsAt: t.startsAt, expiresAt: t.expiresAt,
      scope: { recipient: t.owner, contracts: [p.contracts.manager, p.contracts.enforcer, COW_SETTLEMENT, COW_VAULT_RELAYER],
        tokens: [t.quoteToken, address('4')], actions: ['limit-entry', 'cancel-remainder', 'managed-exit'] } },
    implementation: { kind: 'cow-candidate', version: 'isolated-v1', status: 'inactive' } };
}
export function authorityVerification(now = NOW): AuthorityVerification {
  return { block: { number: '101', hash, timestamp: now }, managerCode: true, implementationCode: true, enforcerCode: true,
    settlementCode: true, vaultRelayerCode: true, tokenCodes: true, ownerImplementation: true, allowances: true, delegationEnabled: true, profileCurrent: true, blockers: [] };
}
export function authorityReview(now = NOW) {
  return createAuthorityReview({ id: randomUUID(), profileRevision: 1, preparation: authorityPreparation(now), now });
}
export function authorityEnvironment(): AuthorityEnvironment {
  return { prepare: async (p, now) => { const result = authorityPreparation(now);
    result.terms.startsAt = p.profile.authority.startsAt; result.terms.expiresAt = p.profile.authority.expiresAt; return result;
  }, verify: async (_r, now) => authorityVerification(now),
    prepareClose: async (_r, now) => ({ block: { number: '102', hash, timestamp: now }, outstandingUids: [], fenceReference: 'isolated-fence:1', blockers: [] }),
    verifyClose: async (_r, _c, now) => ({ block: { number: '103', hash, timestamp: now }, delegationDisabled: true,
      allowancesZero: true, allTrackedOrdersTerminal: true, entriesFenced: true, blockers: [] }) };
}

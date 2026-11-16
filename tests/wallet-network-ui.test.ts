import { describe, expect, it } from 'vitest';
import { matchesStrategyWallet, strategyChainId, strategyNetwork, validWalletFeasibility, walletAssetLabel } from '../src/lib/wallet/strategy-network-ui';
import { currentFeasibility, type WalletFeasibility } from '../src/lib/wallet/wallet-feasibility';
import gnosis from '../src/lib/wallet/generated/gnosis-contracts.json';
import ethereum from '../src/lib/wallet/generated/mainnet-contracts.json';

const now = 1794790000000, owner = '0x1111111111111111111111111111111111111111';
const wallet = (chainId = '100') => ({ address: owner, chainId, nativeBalance: '0' });
function audit(chainId: 1 | 100 = 100): WalletFeasibility {
  return { version: 1, chainId, owner, readAt: now, expiresAt: now + 15000,
    block: { number: '49300370', hash: '0x' + 'a'.repeat(64), timestamp: now / 1000 },
    assets: chainId === 100 ? [
      { symbol: 'XDAI', address: null, decimals: 18, balanceRaw: '0', role: 'gas' },
      { symbol: 'USDCE', address: gnosis.contracts.quoteToken, decimals: 6, balanceRaw: '0', role: 'configured-quote' },
    ] : [
      { symbol: 'ETH', address: null, decimals: 18, balanceRaw: '0', role: 'gas' },
      { symbol: 'USDC', address: ethereum.contracts.quoteToken, decimals: 6, balanceRaw: '0', role: 'configured-quote' },
      { symbol: 'mUSD', address: '0xaca92e438df0b2401ff60da7e4337b687a2435da', decimals: 6, balanceRaw: '10807268', role: 'held-unconfigured' },
    ], samples: [{ quoteSymbol: chainId === 100 ? 'USDCE' : 'mUSD', allocationPercent: 10, budgetRaw: '0', status: 'unavailable',
      entryFeeRaw: null, entryFeeFraction: null, roundTripCostFraction: null, gasCostUpperFraction: null, totalCostUpperFraction: null,
      sourceAt: null, expiresAt: null, reason: 'wallet_sample_budget_empty' }], maximumCostFraction: '0.004', decision: 'blocked',
    blockers: ['wallet_sample_budget_empty'], setupCosts: 'not-estimated', createdExecutionState: false };
}
describe('explicit network-specific wallet response boundary', () => {
  it('accepts exact chain100 two-asset and legacy chain1 three-asset evidence without promoting it to readiness', () => {
    expect(validWalletFeasibility(audit(), wallet(), now)).toBe(true);
    expect(validWalletFeasibility(audit(1), wallet('1'), now)).toBe(true);
    expect(currentFeasibility(audit(), owner, '100', now)).toBe(false);
    expect(currentFeasibility({ ...audit(), decision: 'eligible-for-setup' }, owner, '100', now)).toBe(true);
    expect(currentFeasibility({ ...audit(), decision: 'eligible-for-setup' }, owner, '1', now)).toBe(false);
  });
  it('displays bridged quote and native gas identities distinctly without aliasing them to Ethereum', () => {
    expect(strategyNetwork('100')).toMatchObject({ name: 'Gnosis (100)', quote: 'USDC.e', native: 'xDAI' });
    expect(strategyNetwork(1)).toMatchObject({ name: 'Ethereum (1)', quote: 'USDC', native: 'ETH' });
    expect(walletAssetLabel('USDCE')).toBe('USDC.e'); expect(walletAssetLabel('XDAI')).toBe('xDAI');
    expect(walletAssetLabel('USDC')).toBe('USDC'); expect(walletAssetLabel('mUSD')).toBe('mUSD');
  });
  it.each(['84532', 84532, '0x64', '100.0', null, undefined, 137])('does not infer an execution network for %j', value => {
    expect(strategyChainId(value)).toBeNull(); expect(strategyNetwork(value)).toBeNull();
  });
  it.each(['chain', 'owner', 'token', 'native-alias', 'quote-alias', 'extra-mUSD', 'decimals', 'sample', 'numeric-raw', 'invalid-date'] as const)(
    'rejects %s rather than showing another asset or chain as available capital', field => {
      const value = audit();
      if (field === 'chain') value.chainId = 1;
      if (field === 'owner') value.owner = '0x' + '2'.repeat(40);
      if (field === 'token') value.assets[1].address = ethereum.contracts.quoteToken;
      if (field === 'native-alias') value.assets[0].symbol = 'ETH';
      if (field === 'quote-alias') value.assets[1].symbol = 'USDC';
      if (field === 'extra-mUSD') value.assets.push(audit(1).assets[2]);
      if (field === 'decimals') value.assets[1].decimals = 18;
      if (field === 'sample') value.samples[0].quoteSymbol = 'mUSD';
      if (field === 'numeric-raw') Object.assign(value.assets[1], { balanceRaw: 100 });
      if (field === 'invalid-date') value.expiresAt = Number.MAX_SAFE_INTEGER;
      expect(validWalletFeasibility(value, wallet(), now)).toBe(false);
    });
  it('requires the same live account and chain and keeps an expired response unusable', () => {
    expect(matchesStrategyWallet(audit(), wallet('1'))).toBe(false);
    expect(matchesStrategyWallet(audit(), { ...wallet(), address: '0x' + '2'.repeat(40) })).toBe(false);
    expect(currentFeasibility({ ...audit(), decision: 'eligible-for-setup' }, owner, '100', now + 15000)).toBe(false);
  });
});

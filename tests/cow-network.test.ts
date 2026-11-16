import { describe, expect, it } from 'vitest';
import { cowNetwork } from '../src/lib/wallet/cow-network';
import ethereum from '../src/lib/wallet/generated/mainnet-contracts.json';
import gnosis from '../src/lib/wallet/generated/gnosis-contracts.json';
describe('fixed CoW network identity', () => {
  it('preserves the exact Ethereum default and binds explicit Gnosis to its own runtime and physical assets', () => {
    expect(cowNetwork()).toBe(cowNetwork(1));
    expect(cowNetwork()).toMatchObject({ chainId: 1, apiNamespace: 'mainnet', nativeCurrency: 'ETH', quoteCurrency: 'USDC', baseKind: 'weth9',
      contracts: { quoteToken: ethereum.contracts.quoteToken, baseToken: ethereum.contracts.weth9 }, codeHashes: { settlement: ethereum.codeHashes.settlement } });
    expect(cowNetwork(100)).toMatchObject({ chainId: 100, apiNamespace: 'xdai', nativeCurrency: 'XDAI', quoteCurrency: 'USDCE', baseKind: 'erc20',
      contracts: { quoteToken: gnosis.contracts.quoteToken, baseToken: gnosis.contracts.wethBridged, wrappedNative: gnosis.contracts.wrappedNative },
      codeHashes: { settlement: gnosis.codeHashes.settlement } });
    expect(cowNetwork(100).codeHashes.settlement).not.toBe(cowNetwork().codeHashes.settlement);
    expect(cowNetwork(100).contracts.baseToken).not.toBe(cowNetwork(100).contracts.wrappedNative);
    expect(Object.isFrozen(cowNetwork(100))).toBe(true); expect(Object.isFrozen(cowNetwork(100).contracts)).toBe(true);
  });
  it.each([0, 10, 56, 8453, 84532, NaN])('never falls back for unsupported explicit chain %s', chain => {
    expect(() => cowNetwork(chain)).toThrow('cow_chain_unsupported');
  });
});

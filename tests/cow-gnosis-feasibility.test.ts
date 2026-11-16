import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { auditCowFeasibility, METAMASK_MUSD, type CowFeasibilityDependencies } from '../src/lib/wallet/cow-feasibility';
import { currentFeasibility, COW_GNOSIS_SETUP_GAS_LIMITS } from '../src/lib/wallet/wallet-feasibility';
import { cowGasWeiPerLeg } from '../src/lib/wallet/cow-gas-limits';
import type { CowQuoteEvidence, CowQuoteRequest } from '../src/lib/wallet/cow-api';
import pins from '../src/lib/wallet/generated/gnosis-contracts.json';
import behavior from '../src/lib/wallet/generated/gnosis-token-behavior.json';
import runtimes from './fixtures/cow-gnosis-runtime.json';
import * as runtime from '../src/lib/wallet/cow-runtime-config';
import * as db from '../src/lib/db';
import * as profile from '../src/lib/wallet/strategy-profile';

const NOW = 1794790000 * 1000, owner = '0x1111111111111111111111111111111111111111' as Address;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function fixture() {
  let now = NOW; const balances = { native: 1000000000000000000n, quote: 10807268n };
  const block = { number: 49300370n, hash: ('0x' + 'a'.repeat(64)) as Hex, timestamp: BigInt(NOW / 1000) };
  const client = { getChainId: vi.fn(async () => 100), getBlock: vi.fn(async () => ({ ...block })),
    getBalance: vi.fn(async () => balances.native), getStorageAt: vi.fn(async () => { throw new Error('No Ethereum implementation slot on Gnosis'); }),
    getCode: vi.fn(async ({ address }: { address: Address; blockNumber?: bigint }): Promise<Hex> => {
      const row = Object.values(runtimes.contracts).find(c => same(c.address, address));
      if (!row) throw new Error('Unscoped runtime'); return row.runtime as Hex;
    }), readContract: vi.fn(async ({ address, functionName }: { address: Address; functionName: string }): Promise<unknown> => {
      if (![behavior.quote.proxy, behavior.base.proxy].some(t => same(t, address))) throw new Error('No unrelated token probe');
      if (functionName === 'balanceOf') { if (!same(address, pins.contracts.quoteToken)) throw new Error('Only physical quote funding'); return balances.quote; }
      if (functionName === 'decimals') return same(address, behavior.quote.proxy) ? 6 : 18;
      if (functionName === 'implementation') return same(address, behavior.quote.proxy) ? behavior.quote.implementation : behavior.base.implementation;
      if (functionName === 'bridgeContract') return behavior.base.bridgeContract;
      throw new Error('Unscoped getter');
    }) };
  // Synthetic exact-size reference: 1WETH=1000USDCE, fee1quote atom. No peg,
  // actual owner balance, executable liquidity, or actual trade is asserted.
  const api = { getQuote: vi.fn(async (r: CowQuoteRequest): Promise<CowQuoteEvidence> => {
    const baseSell = same(r.sellToken, pins.contracts.wethBridged), amount = BigInt(r.amount), fee = baseSell ? 1000000000n : 1n;
    return { ...r, owner: r.owner as Address, receiver: r.receiver as Address, sellToken: r.sellToken as Address, buyToken: r.buyToken as Address,
      sellAmount: (r.kind === 'buy' ? (amount + 999999999n) / 1000000000n : amount - fee).toString(),
      buyAmount: (r.kind === 'buy' ? amount : baseSell ? (amount - fee) / 1000000000n : (amount - fee) * 1000000000n).toString(),
      quotedFeeAmount: fee.toString(), chainId: 100, verified: true, partiallyFillable: false, quoteId: 1,
      readAt: now, expiration: new Date(now + 30000).toISOString() };
  }) };
  const market = { referenceBook: vi.fn(async () => { throw new Error('No ETH price substitution'); }),
    nativeGasReference: vi.fn(async () => ({ currency: 'XDAI', productId: 'isolated-wxdai-usdce', bid: '0.82', ask: '0.83',
      tradeId: 'isolated-native-pool', sourceId: 'isolated-xdai-eur-derived', referenceOnly: true as const, tradeAt: now / 1000, readAt: now / 1000 })),
    fundingConversion: vi.fn(async () => ({ currency: 'USDCE', eurPerUnit: '0.91', sourceAt: now / 1000,
      rateAt: NOW / 1000 - 3600, rateMaxAgeSeconds: 86400, sourceId: 'isolated-explicit-underlying-usdc-eur-reference' })) };
  const deps: CowFeasibilityDependencies = { client: client as unknown as CowFeasibilityDependencies['client'], api, market, clock: () => now };
  return { balances, block, client, api, market, deps, advance: (seconds: number) => { now += seconds * 1000; } };
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network in Gnosis review tests'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('explicit Gnosis setup-only review evidence', () => {
  it('uses actual reviewed chain100 contracts and distinct native/physical funding currencies without creating execution state', async () => {
    const f = fixture(), executor = vi.spyOn(runtime, 'cowExecutor'), sql = vi.spyOn(db, 'query'), tx = vi.spyOn(db, 'transaction'), save = vi.spyOn(profile, 'saveStrategyProfile');
    const audit = await auditCowFeasibility(owner, 100, f.deps);
    expect(audit).toMatchObject({ chainId: 100, decision: 'eligible-for-setup', createdExecutionState: false, setupCosts: 'not-estimated' });
    expect(audit.assets.map(a => a.symbol)).toEqual(['XDAI', 'USDCE']);
    expect(audit.assets[1]).toMatchObject({ address: pins.contracts.quoteToken.toLowerCase(), balanceRaw: '10807268' });
    expect(audit.samples.map(s => s.budgetRaw)).toEqual(['1080726', '540363']);
    expect(audit.samples.every(s => s.status === 'complete' && Number(s.totalCostUpperFraction) <= .004 && Number(s.gasCostUpperFraction) > 0)).toBe(true);
    expect(cowGasWeiPerLeg(COW_GNOSIS_SETUP_GAS_LIMITS) * 2n).toBe(112000000000000n);
    expect(f.market.referenceBook).not.toHaveBeenCalled(); expect(f.client.getStorageAt).not.toHaveBeenCalled();
    expect(f.client.readContract.mock.calls.some(([q]) => same(q.address, METAMASK_MUSD))).toBe(false);
    expect(currentFeasibility(audit, owner, '100', NOW)).toBe(true); expect(currentFeasibility(audit, owner, '1', NOW)).toBe(false);
    expect(executor).not.toHaveBeenCalled(); expect(sql).not.toHaveBeenCalled(); expect(tx).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it.each(['ethereum-quote', 'ethereum-native', 'usdc-alias', 'changed-implementation', 'provider', 'stale-after-io'] as const)(
    'never makes setup review eligible after %s', async fault => {
      const f = fixture();
      if (fault === 'ethereum-quote') { const base = f.api.getQuote.getMockImplementation()!; f.api.getQuote.mockImplementation(async r => ({ ...await base(r), chainId: 1 })); }
      if (fault === 'ethereum-native') { const base = f.market.nativeGasReference.getMockImplementation()!; f.market.nativeGasReference.mockImplementation(async () => ({ ...await base(), currency: 'ETH' })); }
      if (fault === 'usdc-alias') { const base = f.market.fundingConversion.getMockImplementation()!; f.market.fundingConversion.mockImplementation(async () => ({ ...await base(), currency: 'USDC' })); }
      if (fault === 'changed-implementation') { const base = f.client.readContract.getMockImplementation()!; f.client.readContract.mockImplementation(async q => q.functionName === 'implementation' ? owner : base(q)); }
      if (fault === 'provider') f.api.getQuote.mockRejectedValue(new Error('https://private:secret@provider.invalid'));
      if (fault === 'stale-after-io') { const base = f.api.getQuote.getMockImplementation()!; let advanced = false;
        f.api.getQuote.mockImplementation(async r => { if (!advanced) { advanced = true; f.advance(16); } return base(r); }); }
      const audit = await auditCowFeasibility(owner, 100, f.deps);
      expect(audit.decision).not.toBe('eligible-for-setup'); expect(audit.createdExecutionState).toBe(false);
      expect(JSON.stringify(audit)).not.toContain('private:secret');
    });
  it('does not turn native gas or an empty Gnosis address into physical trading capital', async () => {
    const f = fixture(); f.balances.quote = 0n;
    const audit = await auditCowFeasibility(owner, 100, f.deps);
    expect(audit).toMatchObject({ decision: 'blocked', samples: [] }); expect(audit.blockers).toContain('wallet_configured_quote_balance_missing');
    expect(f.api.getQuote).not.toHaveBeenCalled();
  });
});

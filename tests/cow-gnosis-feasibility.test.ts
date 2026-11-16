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
  it('keeps the existing one-atom seed headroom when an independent exact BUY already fits the immutable budget', async () => {
    const f = fixture(); f.balances.quote = 9805893n;
    const native = f.market.nativeGasReference.getMockImplementation()!;
    // Explicit synthetic FX equality makes the compiled roundtrip gas upper
    // exactly112 quote atoms, separate from any assertion of a currency peg.
    f.market.nativeGasReference.mockImplementation(async () => ({ ...await native(), ask: '0.91' }));
    const original = f.api.getQuote.getMockImplementation()!;
    f.api.getQuote.mockImplementation(async request => {
      const quote = await original(request);
      return request.kind === 'buy' ? { ...quote, sellAmount: (BigInt(quote.sellAmount) + 1n).toString() } : quote;
    });
    const audit = await auditCowFeasibility(owner, 100, f.deps);
    expect(audit.decision).toBe('eligible-for-setup');
    expect(f.api.getQuote).toHaveBeenCalledTimes(6);
    for (const sample of audit.samples) {
      const budget = BigInt(sample.budgetRaw), seedBudget = budget - 56n - 1n;
      const seed = f.api.getQuote.mock.calls.find(([q]) => q.kind === 'sell' && same(q.sellToken, pins.contracts.quoteToken) && q.amount === seedBudget.toString())?.[0];
      expect(seed).toBeDefined();
      const quantity = ((seedBudget - 1n) * 1000000000n).toString();
      expect(f.api.getQuote.mock.calls.some(([q]) => q.kind === 'buy' && q.amount === quantity)).toBe(true);
      expect(f.api.getQuote.mock.calls.some(([q]) => same(q.sellToken, pins.contracts.wethBridged) && q.amount === quantity)).toBe(true);
      const paid = seedBudget + 1n;
      expect(paid + 56n).toBe(budget);
      expect(sample.status).toBe('complete');
      expect(Number(sample.totalCostUpperFraction)).toBeLessThan(.004);
      expect(sample.reason).toBeNull();
    }
    expect(audit.createdExecutionState).toBe(false);
  });
  it('reduces exact base quantity after the observed 339-atom BUY change, then sells only the newly fitted size for both unchanged allocations',async()=>{
    const f=fixture();f.balances.quote=9803463n;
    const native=f.market.nativeGasReference.getMockImplementation()!;
    f.market.nativeGasReference.mockImplementation(async()=>({...await native(),ask:'0.91'}));
    const original=f.api.getQuote.getMockImplementation()!,base=529119358943354n;
    // Raw ratios observed by a read-only projection; times/balances here remain
    // synthetic. No executable depth, funded account or live certificate claim.
    const trace:{kind:'seed'|'buy'|'sell';quantity:bigint;paid?:bigint}[]=[];
    f.api.getQuote.mockImplementation(async request=>{
      const q=await original(request),amount=BigInt(request.amount);
      if(request.kind==='buy'){
        const paid=(amount*980628n+base-1n)/base;trace.push({kind:'buy',quantity:amount,paid});
        return{...q,sellAmount:(paid-1n).toString()};
      }
      if(same(request.sellToken,pins.contracts.quoteToken)){
        const quantity=amount*base/980289n;trace.push({kind:'seed',quantity});return{...q,buyAmount:quantity.toString()};
      }
      trace.push({kind:'sell',quantity:amount});
      return{...q,sellAmount:(amount-22747972n).toString(),quotedFeeAmount:'22747972',buyAmount:(amount*977844n/base).toString()};
    });
    const audit=await auditCowFeasibility(owner,100,f.deps);
    expect(audit.decision).toBe('eligible-for-setup');expect(audit.samples.map(s=>s.budgetRaw)).toEqual(['980346','490173']);
    expect(f.api.getQuote).toHaveBeenCalledTimes(8); // Two seeds, four BUYs, two fitted SELLs.
    for(const s of audit.samples){
      const budget=BigInt(s.budgetRaw),large=s.allocationPercent===10;
      const belongs=(q:bigint)=>(q>base*3n/4n)===large;
      const buys=trace.filter(t=>t.kind==='buy'&&belongs(t.quantity));
      expect(buys).toHaveLength(2);expect(buys[0].paid!+56n).toBeGreaterThan(budget);
      expect(buys[1].quantity).toBeLessThan(buys[0].quantity);expect(buys[1].paid!+56n).toBeLessThanOrEqual(budget);
      const sell=trace.find(t=>t.kind==='sell'&&belongs(t.quantity))!;
      expect(sell.quantity).toBe(buys[1].quantity);expect(trace.indexOf(sell)).toBeGreaterThan(trace.indexOf(buys[1]));
      expect(s).toMatchObject({status:'complete',reason:null});expect(Number(s.totalCostUpperFraction)).toBeLessThan(.004);
    }
    expect(audit.createdExecutionState).toBe(false);
  });
  it('stops after three strictly decreasing BUY sizes when the independent quote keeps exceeding the budget, without any reverse SELL',async()=>{
    const f=fixture(),native=f.market.nativeGasReference.getMockImplementation()!;
    f.market.nativeGasReference.mockImplementation(async()=>({...await native(),ask:'0.91'}));
    const original=f.api.getQuote.getMockImplementation()!,sizes=new Map<number,bigint[]>([[10,[]],[5,[]]]);
    f.api.getQuote.mockImplementation(async request=>{
      const q=await original(request);if(request.kind!=='buy')return q;
      const size=BigInt(request.amount),allocation=size>800000n*1000000000n?10:5,list=sizes.get(allocation)!;
      list.push(size);const budget=f.balances.quote*BigInt(allocation)/100n;
      return{...q,sellAmount:(budget-56n+339n+BigInt(list.length)-1n).toString()};
    });
    const audit=await auditCowFeasibility(owner,100,f.deps);
    expect(audit.decision).toBe('unproven');expect(f.api.getQuote).toHaveBeenCalledTimes(8);
    for(const list of sizes.values()){expect(list).toHaveLength(3);expect(list.every(q=>q>0n)).toBe(true);expect(list[1]).toBeLessThan(list[0]);expect(list[2]).toBeLessThan(list[1]);}
    expect(audit.samples.every(s=>s.status==='partial'&&s.reason==='wallet_sample_entry_budget_exceeded'&&s.totalCostUpperFraction===null)).toBe(true);
    expect(f.api.getQuote.mock.calls.some(([q])=>same(q.sellToken,pins.contracts.wethBridged))).toBe(false);
  });
  it('stops before another request when a positive atomic BUY quantity would shrink to zero',async()=>{
    const f=fixture(),original=f.api.getQuote.getMockImplementation()!;
    f.api.getQuote.mockImplementation(async request=>{
      const q=await original(request);return request.kind==='buy'?{...q,sellAmount:'1000000000000000000'}:{...q,buyAmount:'1'};
    });
    const audit=await auditCowFeasibility(owner,100,f.deps);
    expect(audit.samples.every(s=>s.reason==='wallet_sample_entry_budget_exceeded')).toBe(true);
    expect(f.api.getQuote).toHaveBeenCalledTimes(4);expect(f.api.getQuote.mock.calls.filter(([q])=>q.kind==='buy').every(([q])=>q.amount==='1')).toBe(true);
    expect(f.api.getQuote.mock.calls.some(([q])=>same(q.sellToken,pins.contracts.wethBridged))).toBe(false);
  });
  it.each(['cow_rate_limited','transport-failure'])('never retries a failed exact BUY or asks for a reverse SELL after %s',async code=>{
    const f=fixture(),original=f.api.getQuote.getMockImplementation()!;
    f.api.getQuote.mockImplementation(async request=>{
      if(request.kind==='buy')throw Object.assign(new Error('private-provider-detail'),{code});return original(request);
    });
    const audit=await auditCowFeasibility(owner,100,f.deps);
    expect(f.api.getQuote).toHaveBeenCalledTimes(4);expect(audit.decision).toBe('unproven');
    expect(audit.samples.every(s=>s.reason==='wallet_sample_quote_unavailable')).toBe(true);
    expect(f.api.getQuote.mock.calls.some(([q])=>same(q.sellToken,pins.contracts.wethBridged))).toBe(false);
    expect(JSON.stringify(audit)).not.toContain('private-provider-detail');
  });
  it('does not renew the original seed/FX window when a later BUY response is freshly timestamped after fifteen seconds',async()=>{
    const f=fixture(),original=f.api.getQuote.getMockImplementation()!;let advanced=false;
    f.api.getQuote.mockImplementation(async request=>{
      if(request.kind==='buy'&&!advanced){advanced=true;f.advance(16);}return original(request);
    });
    const audit=await auditCowFeasibility(owner,100,f.deps);
    expect(f.api.getQuote).toHaveBeenCalledTimes(3);expect(audit.decision).not.toBe('eligible-for-setup');
    expect(audit.samples.some(s=>s.reason==='wallet_sample_cost_stale')).toBe(true);
    // The sibling sample's seed can itself be stale before its continuation.
    expect(audit.samples.every(s=>s.status!=='complete'&&['wallet_sample_cost_stale','wallet_sample_quote_unavailable'].includes(s.reason!)
      &&(s.expiresAt===null||s.expiresAt<=NOW+15000)&&s.totalCostUpperFraction===null)).toBe(true);
    expect(f.api.getQuote.mock.calls.some(([q])=>same(q.sellToken,pins.contracts.wethBridged))).toBe(false);
  });
  it.each([20n, 560n, 570n])('never requests an empty or negative post-gas seed for a tiny capital of %s raw atoms', async capital => {
    const f = fixture(); f.balances.quote = capital;
    const native = f.market.nativeGasReference.getMockImplementation()!;
    f.market.nativeGasReference.mockImplementation(async () => ({ ...await native(), ask: '0.91' }));
    const audit = await auditCowFeasibility(owner, 100, f.deps);
    expect(audit.decision).toBe('unproven');
    expect(audit.samples.every(s => s.status === 'unavailable' && s.reason === 'wallet_sample_entry_budget_exceeded')).toBe(true);
    expect(f.api.getQuote).not.toHaveBeenCalled();
  });
});

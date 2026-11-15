import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';
import { CowMarketQuotes } from '../src/lib/wallet/cow-market-quotes';
import { setupPolicy } from '../src/lib/wallet/cow-setup';
import type { CowRuntimeConfig } from '../src/lib/wallet/cow-runtime-config';
import type { CoinbaseMarketClient, CoinbaseMarketMapping } from '../src/lib/wallet/coinbase-market';
import type { CowReadClient, CowQuoteRequest } from '../src/lib/wallet/cow-api';
import { CONFIG, decimal, type RiskResult } from '../src/lib/execution/v1/model';
import { evaluateRisk } from '../src/lib/execution/v1/risk';
import { NOW, account, instrument, position, quote, signal } from './execution-fixtures';
const owner = '0x1111111111111111111111111111111111111111', executor = '0x2222222222222222222222222222222222222222';
const mapping: CoinbaseMarketMapping = { version: 1, chainId: 1, tokenAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', tokenDecimals: 18,
  currency: 'WETH', referenceCurrency: 'ETH', symbol: 'WETH-EUR', productId: 'ETH-EUR', provider: 'coinbase-exchange-eur-reference-v1',
  method: 'weth9-native-redemption-reference-v1', sourceId: 'isolated-reference' };
function fixture(reduced = false) {
  const a = account(), conversion = { currency: 'USDC', eurPerUnit: '1', sourceAt: NOW, rateAt: NOW, rateMaxAgeSeconds: 90000, sourceId: 'isolated-fx' };
  a.balances = [{ currency: 'USDC', available: '1000', total: '1000', reserved: '0' }];
  a.funding = { ...conversion, available: '1000', total: '1000', reserved: '0' };
  const i = instrument('WETH-EUR'); i.costs = { buyFeeRate: '0', sellFeeRate: '0', buyFixedEur: '0', sellFixedEur: '0',
    buySlippageRate: '0', sellSlippageRate: '0', source: 'isolated-seed', observedAt: NOW, depthRequired: true };
  const q = { ...quote('WETH-EUR'), conversion, depth: { bids: [{ price: '99.99', quantity: '10' }], asks: [{ price: '100', quantity: '10' }] } };
  const terms = setupPolicy({ owner, executor, quoteRaw: 1000_000000n, now: NOW, markets: [{ mapping, euroPrice: '100' }], eurPerQuote: '1' });
  const config = { terms, mappings: [mapping], gasLimits: { maxGas: '100000', maxFeePerGasWei: '1000000000', maxPriorityFeePerGasWei: '100000000',
    maxTransactionCostWei: '100000000000000' } } as CowRuntimeConfig;
  let ask = '100', bid = '99.99', verified = true;
  const api = { getQuote: vi.fn(async (r: CowQuoteRequest) => {
    const base = decimal(r.amount).div('1000000000000000000');
    return { ...r, buyAmount: r.kind === 'buy' ? r.amount : base.mul(bid).mul('1000000').floor().toFixed(0),
      sellAmount: r.kind === 'sell' ? r.amount : base.mul(ask).mul('1000000').ceil().toFixed(0), quotedFeeAmount: '0', quoteId: 42,
      partiallyFillable: true, verified, readAt: NOW * 1000, expiration: new Date((NOW + 30) * 1000).toISOString() };
  }) };
  const market = { referenceBook: vi.fn(async () => ({ ask: '100', bid: '99.99' })) };
  const client = { estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 100000000n })) };
  const risk: RiskResult = evaluateRisk({ reduced, dailyHaltDate: null }, [], a.equityHistory, true, NOW);
  const quotes = new CowMarketQuotes({ config, client: client as unknown as PublicClient, market: market as unknown as CoinbaseMarketClient,
    api: api as unknown as CowReadClient, balances: async () => [], clock: () => NOW });
  return { a, i, q, risk, api, config, quotes, market, prices: (buy: string, sell = '99.99') => { ask = buy; bid = sell; }, unverified: () => { verified = false; } };
}
function atomicFixture(reduced = false, rate = '1', ask = '150', bid = ask) {
  const f = fixture(reduced), equity = decimal('100000').mul(rate).toFixed();
  f.a.availableEur = equity; f.a.equityEur = equity;
  f.a.balances = [{ currency: 'USDC', available: '100000', total: '100000', reserved: '0' }];
  f.a.funding = { ...f.a.funding!, eurPerUnit: rate, available: '100000', total: '100000', reserved: '0' };
  f.a.equityHistory = f.a.equityHistory.map(point => ({ ...point, equityEur: equity }));
  f.i.quantityStep = '0.000000000000000001'; f.i.priceStep = '0.000000000001';
  f.i.costs = { ...f.i.costs!, buyFixedEur: '9', sellFixedEur: '9' };
  const eurAsk = decimal(ask).mul(rate).toFixed(), eurBid = decimal(bid).mul(rate).toFixed();
  f.q.ask = eurAsk; f.q.bid = eurBid; f.q.conversion = { ...f.q.conversion, eurPerUnit: rate };
  f.q.depth = { bids: [{ price: eurBid, quantity: '1000' }], asks: [{ price: eurAsk, quantity: '1000' }] };
  f.config.terms = setupPolicy({ owner, executor, quoteRaw: 100000_000000n, now: NOW,
    markets: [{ mapping, euroPrice: eurAsk }], eurPerQuote: rate });
  f.config.gasLimits = { maxGas: '1500000', maxFeePerGasWei: '20000000000', maxPriorityFeePerGasWei: '2000000000',
    maxTransactionCostWei: '30000000000000000' };
  f.market.referenceBook.mockResolvedValue({ ask: '150', bid: '150' }); // Existing ceiling gives EUR9 per leg.
  f.prices(ask, bid);
  return { ...f, entrySignal: { ...signal('WETH-EUR'), close: eurAsk } };
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network in exact entry planning tests'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('exact executable quantity before the durable strategy decision', () => {
  it.each([false, true])('re-quotes the actual %s reduced allocation and stores raw exact-size evidence', async reduced => {
    const f = fixture(reduced), result = await f.quotes.entryPlan(f.a, signal('WETH-EUR'), f.i, f.q, f.risk, NOW);
    expect(result.reason).toBe('entry'); expect(result.intent?.allocation).toBe(reduced ? '0.05' : '0.10');
    const size = result.intent!.quantity, requests = f.api.getQuote.mock.calls.map(([r]) => r);
    expect(requests.at(-1)?.amount).toBe(decimal(size).mul('1000000000000000000').toFixed(0));
    expect(requests.at(-2)?.kind).toBe('buy'); expect(requests.at(-1)?.kind).toBe('sell');
    expect(result.intent?.quote.exactSize).toMatchObject({ provider: 'cow-mainnet-v1', quantity: size, buyQuoteId: 42, sellQuoteId: 42 });
    expect(result.intent).toMatchObject({ stopFraction: '0.02', targetFraction: '0.04', expiresAt: NOW + 60 });
    expect(Number(result.intent?.estimatedCostFraction)).toBeLessThanOrEqual(Number(CONFIG.maximumRoundTripCost));
  });
  it('quotes exposure-room and explicit preclaim quantity caps instead of scaling the larger book', async () => {
    const f = fixture(); f.a.positions = [{ ...position('AAA-EUR'), marketValueEur: '280' }];
    const result = await f.quotes.entryPlan(f.a, signal('WETH-EUR'), f.i, f.q, f.risk, NOW, '0.15');
    expect(result.intent?.quantity).toBe('0.15'); expect(result.intent?.budgetEur).toBe('20');
    expect(f.api.getQuote.mock.calls.every(([r]) => r.amount === '150000000000000000')).toBe(true);
  });
  it('rejects a costly small order even when the seed price suggests a cheap larger quote', async () => {
    const f = fixture(true); f.prices('100.2', '99.7');
    expect(await f.quotes.entryPlan(f.a, signal('WETH-EUR'), f.i, f.q, f.risk, NOW)).toMatchObject({ intent: null, reason: 'round_trip_cost_limit' });
  });
  it('shrinks and requotes price-dependent size and refuses a third still-changing atomic quantity', async () => {
    const f = fixture(), original = f.api.getQuote.getMockImplementation()!; let pair = 0;
    f.i.quantityStep = '0.000000000000000001'; f.i.priceStep = '0.000000000001';
    f.api.getQuote.mockImplementation(async r => { if (r.kind === 'buy') { pair++; f.prices((100 + pair * 0.05).toFixed(2), '100'); } return original(r); });
    expect(await f.quotes.entryPlan(f.a, signal('WETH-EUR'), f.i, f.q, f.risk, NOW)).toMatchObject({ intent: null, reason: 'wallet_exact_quote_unstable' });
    expect(f.api.getQuote).toHaveBeenCalledTimes(6);
  });
  it.each([{ reduced: false, rate: '1', ask: '150' }, { reduced: true, rate: '1', ask: '150' },
    { reduced: false, rate: '1.2', ask: '150.1' }, { reduced: true, rate: '1.2', ask: '150.1' }])(
    'converges for atomic quote/price rounding at reduced=$reduced FX=$rate without changing fees or the budget', async input => {
      const f = atomicFixture(input.reduced, input.rate, input.ask), result = await f.quotes.entryPlan(f.a, f.entrySignal, f.i, f.q, f.risk, NOW);
      expect(result.reason).toBe('entry'); const intent = result.intent!, exact = intent.quote.exactSize!;
      expect(intent.allocation).toBe(input.reduced ? CONFIG.reducedAllocation : CONFIG.allocation);
      expect(intent.budgetEur).toBe(decimal(f.a.availableEur).mul(intent.allocation).toFixed());
      expect(intent.expectedEntryFeeEur).toBe('9');
      expect(decimal(intent.estimatedCostFraction).lte(CONFIG.maximumRoundTripCost)).toBe(true);
      const signedQuoteRaw = decimal(intent.quantity).mul(intent.limitPrice).div(input.rate).mul('1000000').floor();
      expect(signedQuoteRaw.gte(decimal(exact.buySellAmount).add(exact.buyFeeAmount))).toBe(true);
      expect(signedQuoteRaw.div('1000000').mul(input.rate).add(intent.expectedEntryFeeEur).lte(intent.budgetEur)).toBe(true);
      expect(exact.quantity).toBe(intent.quantity);
      const finalPair = f.api.getQuote.mock.calls.slice(-2).map(([request]) => request);
      expect(finalPair.map(request => request.kind)).toEqual(['buy', 'sell']);
      expect(finalPair.every(request => request.amount === decimal(intent.quantity).mul('1000000000000000000').toFixed(0))).toBe(true);
      const preclaim = await f.quotes.entryPlan(f.a, f.entrySignal, f.i, f.q, f.risk, NOW, intent.quantity);
      expect(preclaim.intent).toMatchObject({ quantity: intent.quantity, limitPrice: intent.limitPrice,
        expectedEntryFeeEur: intent.expectedEntryFeeEur, budgetEur: intent.budgetEur });
    });
  it('resolves the composed-cycle EUR150/149.9 quote loop while retaining the reduced-allocation cost rejection', async () => {
    const f = atomicFixture(false, '1', '150', '149.9'), result = await f.quotes.entryPlan(f.a, f.entrySignal, f.i, f.q, f.risk, NOW);
    expect(result.reason).toBe('entry'); expect(result.intent!.budgetEur).toBe('10000');
    expect(result.intent!.expectedEntryFeeEur).toBe('9');
    const g = atomicFixture(true, '1', '150', '149.9');
    expect(await g.quotes.entryPlan(g.a, g.entrySignal, g.i, g.q, g.risk, NOW)).toMatchObject({ intent: null, reason: 'round_trip_cost_limit' });
  });
  it('requires verified responses and rejects a stop below the signed emergency sell floor without changing the 2% rule', async () => {
    const f = fixture(); f.unverified();
    expect(await f.quotes.entryPlan(f.a, signal('WETH-EUR'), f.i, f.q, f.risk, NOW)).toMatchObject({ intent: null, reason: 'wallet_exact_quote_unavailable' });
    const g = fixture(); g.config.terms.markets[0].sellFloorQuote = '99000000';
    expect(await g.quotes.entryPlan(g.a, signal('WETH-EUR'), g.i, g.q, g.risk, NOW)).toMatchObject({ intent: null, reason: 'cow_policy_price_scope_blocked' });
  });
});

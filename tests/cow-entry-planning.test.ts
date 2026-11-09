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
  return { a, i, q, risk, api, config, quotes, prices: (buy: string, sell = '99.99') => { ask = buy; bid = sell; }, unverified: () => { verified = false; } };
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
  it('shrinks and requotes price-dependent size and refuses a third still-changing quantity', async () => {
    const f = fixture(), original = f.api.getQuote.getMockImplementation()!; let pair = 0;
    f.api.getQuote.mockImplementation(async r => { if (r.kind === 'buy') { pair++; f.prices((100 + pair * 0.1).toFixed(2), '100'); } return original(r); });
    expect(await f.quotes.entryPlan(f.a, signal('WETH-EUR'), f.i, f.q, f.risk, NOW)).toMatchObject({ intent: null, reason: 'wallet_exact_quote_unstable' });
    expect(f.api.getQuote).toHaveBeenCalledTimes(6);
  });
  it('requires verified responses and rejects a stop below the signed emergency sell floor without changing the 2% rule', async () => {
    const f = fixture(); f.unverified();
    expect(await f.quotes.entryPlan(f.a, signal('WETH-EUR'), f.i, f.q, f.risk, NOW)).toMatchObject({ intent: null, reason: 'wallet_exact_quote_unavailable' });
    const g = fixture(); g.config.terms.markets[0].sellFloorQuote = '99000000';
    expect(await g.quotes.entryPlan(g.a, signal('WETH-EUR'), g.i, g.q, g.risk, NOW)).toMatchObject({ intent: null, reason: 'cow_policy_price_scope_blocked' });
  });
});

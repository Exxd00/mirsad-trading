import { describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';
import { CowMarketQuotes } from '../src/lib/wallet/cow-market-quotes';
import { setupPolicy } from '../src/lib/wallet/cow-setup';
import type { CowRuntimeConfig } from '../src/lib/wallet/cow-runtime-config';
import type { CoinbaseMarketClient, CoinbaseMarketMapping } from '../src/lib/wallet/coinbase-market';
import type { CowReadClient } from '../src/lib/wallet/cow-api';
import { emptyAccounting, extendValuations } from '../src/lib/execution/v1/accounting';
import type { ExternalExpense } from '../src/lib/execution/v1/source-model';
import { berlinBounds, neutralSeries } from '../src/lib/execution/v1/risk';
import { NOW } from './execution-fixtures';
const owner = '0x1111111111111111111111111111111111111111', executor = '0x2222222222222222222222222222222222222222';
const mapping: CoinbaseMarketMapping = { version: 1, chainId: 1, tokenAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', tokenDecimals: 18,
  currency: 'WETH', referenceCurrency: 'ETH', symbol: 'WETH-EUR', productId: 'ETH-EUR', provider: 'coinbase-exchange-eur-reference-v1',
  method: 'weth9-native-redemption-reference-v1', sourceId: 'isolated-reference' };
function fixture(physicalBase = '0', physicalQuote = '1000') {
  const terms = setupPolicy({ owner, executor, quoteRaw: 1000_000000n, now: NOW,
    markets: [{ mapping, euroPrice: '90' }], eurPerQuote: '0.9' });
  const config = { terms, mappings: [mapping], gasLimits: { maxGas: '100000', maxFeePerGasWei: '20000000000',
    maxPriorityFeePerGasWei: '2000000000', maxTransactionCostWei: '10000000000000000' } } as CowRuntimeConfig;
  const rpc = { estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n })) };
  const market = { fundingConversion: vi.fn(async () => ({ currency: 'USDC', eurPerUnit: '0.9', sourceAt: NOW,
    rateAt: NOW, rateMaxAgeSeconds: 15, sourceId: 'isolated-usdc-eur' })), referenceBook: vi.fn(async (currency: string) => ({
      bid: currency === 'ETH' ? '90' : '90', ask: '90', readAt: NOW, tradeAt: NOW })),
    valuationCandles: vi.fn(async (_c: string, _since: number, until: number) => [{ at: until / 1000, price: '0.89' }]) };
  const api = { getQuote: vi.fn(async (input: { kind: string; amount: string }) => ({ sellAmount: input.kind === 'buy' ? '100000000' : input.amount,
    buyAmount: input.kind === 'buy' ? input.amount : '99000000', quotedFeeAmount: input.kind === 'buy' ? '100000' : '0',
    verified: true, quoteId: 1, readAt: NOW * 1000, expiration: new Date((NOW + 30) * 1000).toISOString() })) };
  const balances = async () => [{ accountId: 'metamask-strategy-v1', currency: 'USDC', available: physicalQuote, reserved: '0', total: physicalQuote,
    observedAt: new Date(NOW * 1000).toISOString() }, { accountId: 'metamask-strategy-v1', currency: 'WETH', available: physicalBase,
    reserved: '0', total: physicalBase, observedAt: new Date(NOW * 1000).toISOString() }];
  const quotes = new CowMarketQuotes({ config, client: rpc as unknown as PublicClient, market: market as unknown as CoinbaseMarketClient,
    api: api as unknown as CowReadClient, balances, clock: () => NOW });
  return { quotes, api, market, rpc, config };
}
describe('actual size-bound quotes and separate executor gas', () => {
  it('uses physical USDC with observed EUR conversion and net CoW fee-inclusive quotes', async () => {
    const f = fixture(), book = await f.quotes.getOrderBook('WETH-EUR');
    expect(book.conversion).toMatchObject({ currency: 'USDC', eurPerUnit: '0.9', rateAt: NOW });
    expect(await f.quotes.getFunding()).toMatchObject({ total: '1000', available: '1000', eurPerUnit: '0.9' });
    expect(Number(book.asks[0].price)).toBeGreaterThan(90);
    expect(Number(book.bids[0].price)).toBeLessThan(Number(book.asks[0].price));
    expect(f.api.getQuote).toHaveBeenCalledTimes(2);
    expect((await f.quotes.instruments())[0].costs).toMatchObject({ buyFeeRate: '0', sellFeeRate: '0', buyFixedEur: '0.36', depthRequired: true });
  });
  it('retains sell instrument capacity after available quote funding is exhausted', async () => {
    const f = fixture('1', '0');
    expect((await f.quotes.instruments())[0]).toMatchObject({ status: 'active', maxOrderSize: '1' });
  });
  it('blocks gas above the reviewed ceiling rather than ignoring the cost', async () => {
    const f = fixture(); f.rpc.estimateFeesPerGas.mockResolvedValue({ maxFeePerGas: 21_000_000_000n, maxPriorityFeePerGas: 100_000_000n });
    await expect(f.quotes.gasReserveEur()).rejects.toThrow('wallet_gas_ceiling_exceeded');
  });
  it('uses the last completed historical minute and has no parity fallback', async () => {
    const f = fixture(); expect(await f.quotes.conversionAt('USDC', NOW + 29)).toBe('0.89');
    expect(f.market.valuationCandles).toHaveBeenCalledWith('USDC', (NOW - 60) * 1000, NOW * 1000);
    f.market.valuationCandles.mockResolvedValue([]);
    await expect(f.quotes.conversionAt('USDC', NOW)).rejects.toThrow('accounting_historical_price_missing');
  });
  it('prepares finite cumulative transport caps in addition to unchanged sizing', () => {
    const { config } = fixture();
    expect(config.terms).toMatchObject({ maxQuotePerBuy: '100000000', maxQuoteTotal: '10000000000', expiresAt: NOW + 7 * 86400 });
    expect(() => setupPolicy({ owner, executor, quoteRaw: 0n, now: NOW, markets: [{ mapping, euroPrice: '90' }], eurPerQuote: '0.9' })).toThrow();
  });
});
describe('external finalized gas accounting', () => {
  const fee = (): ExternalExpense => ({ id: 'gas:1', at: NOW - 60, amountEur: '1', transactionHash: '0x' + '1'.repeat(64), source: 'canonical-finalized-gas' });
  it('reduces measured return once without inventing a native ETH capital deposit', () => {
    const observations = extendValuations(emptyAccounting(), { at: NOW, amounts: { EUR: '1000' } }, [], [], '1000', [fee()]);
    expect(observations[0]).toMatchObject({ at: berlinBounds(NOW).start, equityEur: '1000' });
    expect(observations.at(-1)).toMatchObject({ equityEur: '999', netFlowEur: '0' });
    expect(neutralSeries(observations, NOW).series.at(-1)?.index).toBe('0.999');
  });
  it('rejects duplicate or revised finalized gas evidence', () => {
    expect(() => extendValuations(emptyAccounting(), { at: NOW, amounts: { EUR: '1000' } }, [], [], '1000', [fee(), fee()])).toThrow('accounting_expense_invalid');
    const old = { ...emptyAccounting(), anchor: { at: NOW - 30, amounts: { EUR: '1000' } }, expenses: [fee()] };
    expect(() => extendValuations(old, { at: NOW, amounts: { EUR: '1000' } }, [], [], '1000', [{ ...fee(), amountEur: '0' }])).toThrow('accounting_expense_revision');
  });
  it('starts first funded capital without classifying a deposit as profit or resetting a later loss', () => {
    const base = { netFlowEur: '0', beforeFlowEquityEur: null, transfersComplete: true };
    const rows = [{ ...base, id: 'empty', at: NOW - 120, equityEur: '0' },
      { ...base, id: 'deposit', at: NOW - 60, equityEur: '1000', netFlowEur: '1000', beforeFlowEquityEur: '0' },
      { ...base, id: 'gas', at: NOW, equityEur: '999' }];
    expect(neutralSeries(rows, NOW).series.at(-1)?.index).toBe('0.999');
    expect(() => neutralSeries(rows.slice(0, 1), NOW)).toThrow('invalid_equity_baseline');
    expect(() => neutralSeries([...rows, { ...base, id: 'wipeout', at: NOW + 1, equityEur: '0' },
      { ...base, id: 'refund', at: NOW + 2, equityEur: '1000', netFlowEur: '1000', beforeFlowEquityEur: '0' }], NOW + 2)).toThrow('zero_return_denominator');
  });
});

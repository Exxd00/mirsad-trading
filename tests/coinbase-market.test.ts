import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoinbaseMarketClient, CoinbaseMarketError, COINBASE_USDC, COINBASE_WETH9,
  type CoinbaseCowToken, type CoinbaseMarketMapping, type CoinbasePriceStore } from '../src/lib/wallet/coinbase-market';
import { CONFIG } from '../src/lib/execution/v1/model';
import { NOW } from './execution-fixtures';

const LINK = '0x514910771af9ca656af840dff83e8264ecf986ca';
const WBTC = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
const tokens: CoinbaseCowToken[] = [
  { chainId: 1, address: LINK, decimals: 18, symbol: 'LINK' },
  { chainId: 1, address: COINBASE_USDC, decimals: 6, symbol: 'USDC' },
  { chainId: 1, address: COINBASE_WETH9, decimals: 18, symbol: 'WETH' },
  { chainId: 1, address: WBTC, decimals: 8, symbol: 'WBTC' },
];
const product = (base: string, overrides = {}) => ({ id: `${base}-EUR`, base_currency: base, quote_currency: 'EUR',
  status: 'online', trading_disabled: false, cancel_only: false, auction_mode: false, ...overrides });
const currency = (id: string, address: string | null, overrides = {}) => ({ id, status: 'online',
  supported_networks: [{ id: 'ethereum', status: 'online', contract_address: address }], ...overrides });
function fixture() {
  const data = {
    products: [product('LINK'), product('USDC'), product('ETH'), product('BTC')],
    currencies: [currency('LINK', LINK), currency('USDC', COINBASE_USDC), currency('ETH', null), currency('BTC', '')],
    ticker: { trade_id: 123, bid: '0.891', ask: '0.8911', time: new Date(NOW * 1000).toISOString() },
    omit: -1, conflict: false,
  };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error' });
    const url = new URL(String(input));
    if (url.hostname === 'raw.githubusercontent.com') return Response.json({ tokens });
    expect(url.origin).toBe('https://api.exchange.coinbase.com');
    if (url.pathname === '/products') return Response.json(data.products);
    if (url.pathname === '/currencies') return Response.json(data.currencies);
    if (url.pathname.endsWith('/ticker')) return Response.json(data.ticker);
    if (url.pathname.endsWith('/candles')) {
      const start = Number(url.searchParams.get('start')), end = Number(url.searchParams.get('end')), step = Number(url.searchParams.get('granularity'));
      const rows = [];
      for (let time = start; time <= end; time += step) {
        if (time === data.omit) continue;
        const price = data.conflict && time === start ? '101' : '100';
        rows.push([time, price, price, price, price, '1']);
      }
      return Response.json(rows.reverse());
    }
    throw Error('unexpected_read');
  });
  const client = (mappings?: CoinbaseMarketMapping[], priceStore?: CoinbasePriceStore) => new CoinbaseMarketClient({ fetch: fetcher, clock: () => NOW, mappings, priceStore });
  return { data, fetcher, client };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('exact Ethereum reference mappings', () => {
  it('discovers only exact contracts and the explicitly approved canonical WETH9 method', async () => {
    const f = fixture(), catalog = await f.client().catalog();
    expect(catalog.map(m => m.symbol)).toEqual(['LINK-EUR', 'USDC-EUR', 'WETH-EUR']);
    expect(catalog.find(m => m.currency === 'LINK')).toMatchObject({ tokenAddress: LINK, referenceCurrency: 'LINK',
      productId: 'LINK-EUR', method: 'exact-ethereum-contract-v1' });
    expect(catalog.find(m => m.currency === 'WETH')).toMatchObject({ tokenAddress: COINBASE_WETH9, referenceCurrency: 'ETH',
      productId: 'ETH-EUR', method: 'weth9-native-redemption-reference-v1' });
    expect(catalog.some(m => m.currency === 'WBTC')).toBe(false);
    expect(catalog.every(m => m.sourceId.startsWith('coinbase-eur:v1:'))).toBe(true);
    expect(f.fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    expect(f.fetcher.mock.calls.some(([url]) => String(url).includes('/orders'))).toBe(false);
  });

  it('never trusts matching tickers, alternate networks or an ambiguous Ethereum contract', async () => {
    const f = fixture(); f.data.currencies[0] = currency('LINK', COINBASE_USDC);
    expect((await f.client().catalog(tokens.filter(t => t.symbol === 'LINK'))).map(m => m.currency)).toEqual([]);
    f.data.currencies[0] = currency('LINK', LINK, { supported_networks: [{ id: 'base', status: 'online', contract_address: LINK }] });
    expect(await f.client().catalog(tokens.filter(t => t.symbol === 'LINK'))).toEqual([]);
    f.data.currencies[0] = currency('LINK', LINK, { supported_networks: [
      { id: 'ethereum', status: 'online', contract_address: LINK }, { id: 'ethereum', status: 'online', contract_address: LINK }] });
    expect(await f.client().catalog(tokens.filter(t => t.symbol === 'LINK'))).toEqual([]);
  });

  it.each([{ trading_disabled: true }, { cancel_only: true }, { auction_mode: true }, { status: 'offline' }])('excludes inactive products %j', flags => {
    const f = fixture(); f.data.products[0] = product('LINK', flags);
    return expect(f.client().catalog(tokens.filter(t => t.symbol === 'LINK'))).resolves.toEqual([]);
  });

  it('keeps mapping identities deterministic across ordering and ignores a list ticker as contract evidence', async () => {
    const f = fixture(); const first = await f.client().catalog(tokens);
    f.data.products.reverse(); f.data.currencies.reverse();
    expect(await f.client().catalog(tokens.map(t => ({ ...t, symbol: 'LIST-TICKER' })).reverse())).toEqual(first);
  });

  it('handles real unrelated one-letter products and null native contract metadata without promoting them', async () => {
    const f = fixture(); f.data.products.push(product('O', { id: 'O-USD', quote_currency: 'USD' }));
    f.data.currencies.push(currency('O', LINK));
    expect((await f.client().catalog(tokens)).map(m => m.currency)).toEqual(['LINK', 'USDC', 'WETH']);
  });

  it('rejects duplicate list contracts, spoofed mappings and general wrapper aliases', async () => {
    const f = fixture(); await expect(f.client().catalog([...tokens, tokens[0]])).rejects.toThrow('coinbase_mapping_invalid');
    const catalog = await f.client().catalog(tokens), link = catalog.find(m => m.currency === 'LINK')!;
    expect(() => f.client([{ ...link, productId: 'ETH-EUR' }])).toThrow('coinbase_mapping_invalid');
    expect(() => f.client([{ ...link, sourceId: 'attacker-controlled' }])).toThrow('coinbase_mapping_invalid');
    const weth = catalog.find(m => m.currency === 'WETH')!;
    expect(() => f.client([{ ...weth, tokenAddress: WBTC }])).toThrow('coinbase_mapping_invalid');
  });

  it('refuses reads when a persisted contract mapping no longer matches live metadata', async () => {
    const f = fixture(), m = (await f.client().catalog(tokens))[0];
    f.data.currencies[0] = currency('LINK', COINBASE_USDC);
    await expect(f.client([m]).candles(m, NOW, null)).rejects.toThrow('coinbase_mapping_changed');
    expect(f.fetcher.mock.calls.filter(([url]) => String(url).includes('/candles'))).toHaveLength(0);
  });
});

describe('completed source candles without synthetic intervals', () => {
  it('loads exactly 1000 ascending completed 15m bars through four bounded public pages', async () => {
    const f = fixture(), m = (await f.client().catalog(tokens)).find(m => m.currency === 'LINK')!;
    const rows = await f.client([m]).candles(m, NOW + 10, null);
    expect(rows).toHaveLength(1000);
    expect(rows[0]).toMatchObject({ source: CONFIG.candleSource, symbol: 'LINK-EUR', openTime: NOW - 900000, complete: true });
    expect(rows.at(-1)?.closeTime).toBe(NOW);
    expect(rows.every((r, i) => !i || r.openTime === rows[i - 1].closeTime)).toBe(true);
    const calls = f.fetcher.mock.calls.filter(([url]) => String(url).includes('/candles'));
    expect(calls).toHaveLength(4);
    expect(calls.every(([url]) => { const p = new URL(String(url)).searchParams; return Number(p.get('end')) - Number(p.get('start')) <= 300 * 900; })).toBe(true);
  });

  it('uses ETH-EUR only for the named WETH9 redemption reference while retaining the WETH symbol', async () => {
    const f = fixture(), m = (await f.client().catalog(tokens)).find(m => m.currency === 'WETH')!;
    const rows = await f.client([m]).candles(m, NOW, NOW - 900);
    expect(rows).toHaveLength(1); expect(rows[0].symbol).toBe('WETH-EUR');
    expect(f.fetcher.mock.calls.filter(([url]) => String(url).includes('/candles')).map(([url]) => new URL(String(url)).pathname)).toEqual(['/products/ETH-EUR/candles']);
  });

  it('rejects a missing actual candle and a conflicting overlapping candle', async () => {
    const f = fixture(), m = (await f.client().catalog(tokens))[0]; f.data.omit = NOW - 900000 + 900;
    await expect(f.client([m]).candles(m, NOW, null)).rejects.toThrow('coinbase_candle_gap');
    f.data.omit = -1; f.data.conflict = true;
    await expect(f.client([m]).candles(m, NOW, null)).rejects.toThrow('coinbase_conflicting_candle');
  });

  it('retains decimal JSON lexemes without an IEEE-754 price/volume round-trip', async () => {
    const f = fixture(), m = (await f.client().catalog(tokens))[0], original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => String(url).includes('/candles')
      ? new Response(`[[${NOW - 900},100.000000000000000000123,100.000000000000000000123,100.000000000000000000123,100.000000000000000000123,9007199254740993.000000000000000001]]`)
      : original(url, init));
    const rows = await f.client([m]).candles(m, NOW, NOW - 900);
    expect(rows[0].close).toBe('100.000000000000000000123');
    expect(rows[0].volume).toBe('9007199254740993.000000000000000001');
  });

  it.each([
    '[[0,0,1,1,1,1]]', '[[0,2,1,1,1,1]]', '[[0,1,1,1,1,-1]]', '[[0,1,1,1,1,1e999]]',
    '[[0,1,1,1,1]]', '{"message":"provider raw credential body"}', 'not-json',
  ])('rejects malformed source candle data', async raw => {
    const f = fixture(), m = (await f.client().catalog(tokens))[0], original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => String(url).includes('/candles') ? new Response(raw) : original(url, init));
    await expect(f.client([m]).candles(m, NOW, NOW - 900)).rejects.toThrow('coinbase_response_invalid');
  });

  it.each([NOW + 900, NOW - 901, NOW - 1001 * 900])('rejects invalid or oversized incremental ranges %s', async after => {
    const f = fixture(), m = (await f.client().catalog(tokens))[0];
    await expect(f.client([m]).candles(m, NOW, after)).rejects.toThrow('coinbase_range_invalid');
  });

  it('returns only actual completed historical 1m marks, without filling an absent minute', async () => {
    const f = fixture(); f.data.omit = NOW - 120;
    const marks = await f.client().valuationCandles('USDC', (NOW - 180) * 1000, NOW * 1000);
    expect(marks).toEqual([{ at: NOW - 120, price: '100' }, { at: NOW, price: '100' }]);
    await expect(f.client().valuationCandles('UNBOUND', (NOW - 180) * 1000, NOW * 1000)).rejects.toThrow('coinbase_mapping_invalid');
  });
});

describe('dated USDC/EUR reference conversion and bounded reads', () => {
  it('reports the real USDC bid and trade timestamp without parity or executable-depth claims', async () => {
    const f = fixture(), client = f.client();
    expect(await client.fundingConversion(NOW)).toMatchObject({ currency: 'USDC', eurPerUnit: '0.891', sourceAt: NOW,
      rateAt: NOW, rateMaxAgeSeconds: 15 });
    expect(await client.referenceBook('USDC')).toMatchObject({ bid: '0.891', ask: '0.8911', tradeId: '123', tradeAt: NOW, referenceOnly: true });
    expect((await client.referenceBook('ETH')).productId).toBe('ETH-EUR');
  });

  it('checks freshness after I/O rather than treating a later observation as future data', async () => {
    const f = fixture(), client = new CoinbaseMarketClient({ fetch: f.fetcher, clock: () => NOW + 1 });
    expect(await client.fundingConversion(NOW)).toMatchObject({ sourceAt: NOW + 1, rateAt: NOW });
    await expect(client.fundingConversion(NOW - 16)).rejects.toThrow('coinbase_quote_stale');
  });

  it.each([NOW - 16, NOW + 1])('rejects an old or future actual source timestamp %s', async timestamp => {
    const f = fixture(); f.data.ticker.time = new Date(timestamp * 1000).toISOString();
    await expect(f.client().fundingConversion(NOW)).rejects.toThrow('coinbase_quote_stale');
  });

  it.each([{ bid: '0' }, { bid: '-1' }, { bid: '1', ask: '0.9' }, { time: 'invalid' }, { trade_id: -1 }])('rejects malformed ticker evidence %j', async change => {
    const f = fixture(); Object.assign(f.data.ticker, change);
    await expect(f.client().referenceBook('USDC')).rejects.toThrow('coinbase_response_invalid');
  });

  it('sanitizes network failures and non-2xx bodies without forwarding provider details', async () => {
    const fetcher = vi.fn(async () => { throw new Error('secret rpc url and raw key'); });
    await expect(new CoinbaseMarketClient({ fetch: fetcher }).products()).rejects.toThrow('coinbase_read_unavailable');
    fetcher.mockImplementation(async () => { throw new Error('second secret'); });
    const bad = new CoinbaseMarketClient({ fetch: async () => new Response('secret raw body', { status: 429 }) });
    await expect(bad.products()).rejects.toThrow('coinbase_read_unavailable');
    expect(new CoinbaseMarketError('coinbase_read_unavailable').message).not.toContain('secret');
  });

  it('bounds response bytes and a stalled read even when fetch ignores AbortSignal', async () => {
    const tooLarge = new CoinbaseMarketClient({ fetch: async () => new Response('[]', { headers: { 'content-length': '5000000' } }) });
    await expect(tooLarge.products()).rejects.toThrow('coinbase_read_unavailable');
    vi.useFakeTimers(); const hanging = new CoinbaseMarketClient({ fetch: () => new Promise<Response>(() => undefined) });
    const check = expect(hanging.products()).rejects.toThrow('coinbase_read_timeout');
    await vi.advanceTimersByTimeAsync(5000); await check;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('completed-minute cache injection', () => {
  const cache = (points: { at: number; price: string }[] = []) => {
    const rows = new Map(points.map(p => [p.at, { ...p }]));
    const store: CoinbasePriceStore = {
      load: vi.fn(async (_product, start, end) => [...rows.values()].filter(p => p.at > start && p.at <= end)),
      save: vi.fn(async (_product, points) => { for (const p of points) {
        if (rows.has(p.at) && rows.get(p.at)!.price !== p.price) throw new CoinbaseMarketError('coinbase_cache_conflict');
        rows.set(p.at, { ...p });
      } }),
    }; return { store, rows };
  };
  it('reuses only complete persisted coverage across client instances after verifying the source mapping', async () => {
    const f = fixture(), c = cache(), first = f.client(undefined, c.store);
    const points = await first.valuationCandles('USDC', (NOW - 180) * 1000, NOW * 1000);
    expect(points).toHaveLength(3); expect(c.store.save).toHaveBeenCalledWith('USDC-EUR', points);
    const calls = () => f.fetcher.mock.calls.filter(([url]) => String(url).includes('/candles')).length;
    expect(calls()).toBe(1);
    expect(await f.client(undefined, c.store).valuationCandles('USDC', (NOW - 180) * 1000, NOW * 1000)).toEqual(points);
    expect(calls()).toBe(1);
    f.data.products[1] = product('USDC', { trading_disabled: true });
    await expect(f.client(undefined, c.store).valuationCandles('USDC', (NOW - 180) * 1000, NOW * 1000)).rejects.toThrow('coinbase_market_inactive');
  });

  it('does not turn a partial cache or absent source interval into complete candle coverage', async () => {
    const f = fixture(), c = cache([{ at: NOW - 120, price: '100' }]); f.data.omit = NOW - 120;
    const points = await f.client(undefined, c.store).valuationCandles('USDC', (NOW - 180) * 1000, NOW * 1000);
    expect(points).toEqual([{ at: NOW - 120, price: '100' }, { at: NOW, price: '100' }]);
    expect(points.some(p => p.at === NOW - 60)).toBe(false);
    expect(c.rows.has(NOW - 60)).toBe(false);
  });

  it.each([
    { points: [{ at: NOW + 60, price: '100' }] }, { points: [{ at: NOW, price: '0' }] },
    { points: [{ at: NOW - 1, price: '100' }] }, { points: [{ at: NOW, price: '100' }, { at: NOW, price: '100' }] },
  ])('rejects corrupt cached minute points before using them', async ({ points }) => {
    const f = fixture(), c = cache(); vi.mocked(c.store.load).mockResolvedValue(points);
    await expect(f.client(undefined, c.store).valuationCandles('USDC', (NOW - 180) * 1000, NOW * 1000)).rejects.toThrow('coinbase_cache_invalid');
  });

  it('does not overwrite an encountered closed-candle revision', async () => {
    const f = fixture(), c = cache([{ at: NOW - 120, price: '99' }]);
    await expect(f.client(undefined, c.store).valuationCandles('USDC', (NOW - 180) * 1000, NOW * 1000)).rejects.toThrow('coinbase_cache_conflict');
    expect(c.rows.get(NOW - 120)?.price).toBe('99');
  });

  it('bounds and sanitizes a stalled or failed cache without silently falling back around invalid evidence', async () => {
    const f = fixture(), c = cache(); vi.mocked(c.store.load).mockRejectedValueOnce(new Error('secret database URL'));
    await expect(f.client(undefined, c.store).valuationCandles('USDC', (NOW - 180) * 1000, NOW * 1000)).rejects.toThrow('coinbase_cache_unavailable');
    vi.useFakeTimers(); vi.mocked(c.store.load).mockImplementation(() => new Promise(() => undefined));
    const check = expect(f.client(undefined, c.store).valuationCandles('USDC', (NOW - 180) * 1000, NOW * 1000)).rejects.toThrow('coinbase_cache_unavailable');
    await vi.advanceTimersByTimeAsync(5001); await check; expect(vi.getTimerCount()).toBe(0);
  });
});

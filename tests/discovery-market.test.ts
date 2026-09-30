import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUniverseState, observeUniverse, parsePublicBook, parsePublicPairs, parsePublicTicker, parsePublicTrades,
  readPublicMarket, readPublicUniverse } from '../src/lib/discovery/market';
import type { MarketPair } from '../src/lib/discovery/model';

const now = 1790806412035;
const rawPair = { base: 'NEW', quote: 'EUR', base_step: '0.00001', quote_step: '0.0001', min_order_size: '0.00001',
  max_order_size: '100000', min_order_size_quote: '0.1', status: 'active' };
const pair = parsePublicPairs({ 'NEW/EUR': rawPair })[0];
const trade = { id: 'trade-1', symbol: 'NEW/EUR', price: '1', quantity: '5', timestamp: now - 1000, side: 'buy', region: 'EEA' };
const book = { data: { bids: [{ price: '0.999', quantity: '100' }], asks: [{ price: '1', quantity: '100' }] }, metadata: { timestamp: now, region: 'EEA' } };
afterEach(() => vi.useRealTimers());

describe('public market parsing and prospective discovery', () => {
  it('creates a baseline without relabelling existing currencies as newly launched, then discovers once', () => {
    const first = observeUniverse(createUniverseState(), [pair], now);
    expect(first.newPairs).toEqual([]);
    expect(first.state.pairs['NEW-EUR']).toMatchObject({ isBaseline: true, firstSeenAt: now, launchAt: null });
    const added: MarketPair = { ...pair, symbol: 'NEXT-EUR', base: 'NEXT' };
    const next = observeUniverse(first.state, [pair, added], now + 60_000);
    expect(next.newPairs).toEqual([expect.objectContaining({ symbol: 'NEXT-EUR', isBaseline: false, launchAt: null })]);
    expect(next.events[0].evidence.meaning).toBe('first_seen_by_this_monitor_not_token_launch_or_listing_time');
    expect(observeUniverse(next.state, [added, pair], now + 120_000).newPairs).toEqual([]);
    expect(observeUniverse(next.state, [added, pair], now).state).toBe(next.state);
    expect(first.state.pairs['NEXT-EUR']).toBeUndefined();
  });
  it('retains the baseline on empty, duplicate, and suspiciously partial universes', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ ...pair, symbol: `N${i}-EUR`, base: `N${i}` }));
    const state = observeUniverse(createUniverseState(), many, now).state;
    for (const incomplete of [[], [pair, pair], many.slice(0, 7)]) {
      const result = observeUniverse(state, incomplete, now + 60_000);
      expect(result.state).toBe(state); expect(result.newPairs).toEqual([]); expect(result.events[0].kind).toBe('universe_rejected');
    }
  });
  it('marks a missing pair ineligible only after a valid universe and does not rediscover its return', () => {
    const other: MarketPair = { ...pair, symbol: 'OTHER-EUR', base: 'OTHER' };
    const first = observeUniverse(createUniverseState(), [other], now).state;
    const added = observeUniverse(first, [pair, other], now + 60_000).state;
    const absent = observeUniverse(added, [other], now + 120_000);
    expect(absent.state.pairs[pair.symbol]).toMatchObject({ status: 'not_observed', isBaseline: false,
      firstSeenAt: now + 60_000, lastSeenAt: now + 60_000 });
    expect(absent.events).toContainEqual(expect.objectContaining({ kind: 'pair_not_observed', symbol: pair.symbol,
      reasons: ['pair_absent_from_current_universe'] }));
    expect(added.pairs[pair.symbol].status).toBe('active');
    const again = observeUniverse(absent.state, [other], now + 180_000);
    expect(again.events).toEqual([]);
    const returned = observeUniverse(again.state, [pair, other], now + 240_000);
    expect(returned.newPairs).toEqual([]);
    expect(returned.state.pairs[pair.symbol]).toMatchObject({ status: 'active', firstSeenAt: now + 60_000, lastSeenAt: now + 240_000 });
  });
  it('rejects malformed or paginated pair responses without accepting a partial subset', () => {
    expect(() => parsePublicPairs({})).toThrow('public_universe_incomplete');
    expect(() => parsePublicPairs({ 'NEW/EUR': rawPair, 'BAD/EUR': { ...rawPair, base: 'BAD', base_step: null } })).toThrow();
    expect(() => parsePublicPairs({ data: { 'NEW/EUR': rawPair }, metadata: { next_cursor: 'next' } })).toThrow();
    expect(() => parsePublicPairs({ 'OTHER/EUR': rawPair })).toThrow('public_pair_identity_invalid');
  });
  it('validates EEA book identity and sorts levels without duplicate price depth inflation', () => {
    expect(parsePublicBook(book)).toMatchObject({ bookAt: now, bids: [{ price: 0.999, quantity: 100 }] });
    expect(() => parsePublicBook({ ...book, metadata: { timestamp: now, region: 'UK' } })).toThrow('public_region_mismatch');
    expect(() => parsePublicBook({ ...book, data: { ...book.data, bids: [...book.data.bids, ...book.data.bids] } })).toThrow('public_book_duplicate_level');
  });
  it('deduplicates real trade IDs and does not claim complete volume on a truncated page', () => {
    expect(parsePublicTrades({ data: [trade, trade], metadata: { timestamp: now, next_cursor: 'more' } }, pair.symbol))
      .toMatchObject({ trades: [{ id: 'trade-1', price: 1, quantity: 5 }], complete: false });
    expect(() => parsePublicTrades({ data: [trade, { ...trade, quantity: '6' }], metadata: { timestamp: now } }, pair.symbol)).toThrow('public_trade_conflict');
    expect(() => parsePublicTrades({ data: [{ ...trade, region: 'UK' }], metadata: { timestamp: now } }, pair.symbol)).toThrow('public_trade_identity_invalid');
  });
  it('rejects a ticker for another symbol instead of using its prices', () => {
    expect(() => parsePublicTicker({ data: [{ symbol: 'OTHER/EUR', region: 'EEA', bid: '1', ask: '2' }], metadata: { timestamp: now } }, pair.symbol))
      .toThrow('public_ticker_identity_invalid');
  });
  it('uses bounded sequential public GETs only, preserving source coverage', async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input); starts.push(Date.now());
      expect(url).toMatch(/^https:\/\/revx\.revolut\.com\/api\/[12]\.0\/public\//);
      expect(url).toContain('region=EEA');
      expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' } });
      if (url.includes('order-book')) return Response.json(book);
      if (url.includes('trades/all')) return Response.json({ data: [trade], metadata: { timestamp: now, next_cursor: 'more' } });
      return Response.json({ data: [{ symbol: 'NEW/EUR', region: 'EEA', bid: '0.999', ask: '1', last_price: '1', quote_volume_24h: '20' }], metadata: { timestamp: now } });
    });
    const resultPromise = readPublicMarket(pair, { fetcher, now: () => now });
    await vi.advanceTimersByTimeAsync(4000);
    const result = await resultPromise;
    expect(result.issues).toEqual([]); expect(result.tradesComplete).toBe(false);
    expect(result.bookAt).toBe(now); expect(fetcher).toHaveBeenCalledTimes(3);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1050);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(1050);
  });
  it('fails a universe request after its deadline even if a fetch adapter ignores abort', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => undefined));
    const pending = expect(readPublicUniverse({ fetcher, timeoutMs: 100 })).rejects.toThrow('public_request_timeout');
    await vi.advanceTimersByTimeAsync(101); await pending;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects bodies above 2 MB before parsing them', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }));
    await expect(readPublicUniverse({ fetcher })).rejects.toThrow('public_body_too_large');
  });
  it('records source errors as unavailable instead of fabricating a market or retrying', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async () => new Response('sensitive diagnostic should not be returned', { status: 429 }));
    const pending = readPublicMarket(pair, { fetcher, now: () => now });
    await vi.advanceTimersByTimeAsync(4000);
    expect(await pending).toMatchObject({ bookAt: null, bids: [], asks: [], trades: [], ticker: null,
      issues: ['book:public_rate_limited', 'trades:public_rate_limited', 'ticker:public_rate_limited'] });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

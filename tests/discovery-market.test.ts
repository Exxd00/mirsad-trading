import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUniverseState, observeUniverse, readPublicMarket, readPublicUniverse, type WalletDiscoverySource } from '../src/lib/discovery/market';
import type { MarketPair, MarketSnapshot } from '../src/lib/discovery/model';
import { discoveryReport, runDiscovery } from '../src/lib/discovery/service';
import { initialRuntime, type DiscoveryJournal } from '../src/lib/discovery/journal';

const now = 1790806412035;
const pair: MarketPair = { symbol: 'NEW-EUR', base: 'NEW', quote: 'EUR', status: 'active', baseStep: 0.00001,
  minOrderSize: 0.00001, maxOrderSize: 100000, minOrderSizeQuote: 0.1 };
const market = (): MarketSnapshot => ({ symbol: pair.symbol, base: pair.base, quote: pair.quote, observedAt: now,
  bookAt: now, bids: [{ price: 0.999, quantity: 100 }], asks: [{ price: 1, quantity: 100 }],
  trades: [{ id: 'trade-1', price: 1, quantity: 5, timestamp: now - 1000, side: 'buy' }],
  ticker: { bid: 0.999, ask: 1, last: 1, quoteVolume24h: 20, timestamp: now }, tradesComplete: false, issues: [] });
const provider = (snapshot: MarketSnapshot = market()): WalletDiscoverySource => ({ universe: async () => [pair], market: async () => snapshot });
const options = (source = provider()) => ({ source, now: () => now });

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Ambient network must not be used'); }));
  vi.stubEnv('DISCOVERY_GOOGLE_SERVICE_EMAIL', ''); vi.stubEnv('DISCOVERY_GOOGLE_PRIVATE_KEY', '');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('prospective discovery history', () => {
  it('creates a baseline without relabelling existing currencies as newly launched, then discovers once', () => {
    const first = observeUniverse(createUniverseState(), [pair], now);
    expect(first.newPairs).toEqual([]);
    expect(first.state.pairs['NEW-EUR']).toMatchObject({ isBaseline: true, firstSeenAt: now, launchAt: null });
    const added: MarketPair = { ...pair, symbol: 'NEXT-EUR', base: 'NEXT' };
    const next = observeUniverse(first.state, [pair, added], now + 60_000);
    expect(next.newPairs).toEqual([expect.objectContaining({ symbol: 'NEXT-EUR', isBaseline: false, launchAt: null })]);
    expect(next.events[0].evidence.meaning).toBe('first_seen_by_this_monitor_not_token_launch_or_listing_time');
    expect(next.events[0].evidence).not.toHaveProperty('region');
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
  it('marks missing pairs ineligible after a valid universe without rediscovering their return', () => {
    const other: MarketPair = { ...pair, symbol: 'OTHER-EUR', base: 'OTHER' };
    const first = observeUniverse(createUniverseState(), [other], now).state;
    const added = observeUniverse(first, [pair, other], now + 60_000).state;
    const absent = observeUniverse(added, [other], now + 120_000);
    expect(absent.state.pairs[pair.symbol]).toMatchObject({ status: 'not_observed', isBaseline: false,
      firstSeenAt: now + 60_000, lastSeenAt: now + 60_000 });
    expect(absent.events).toContainEqual(expect.objectContaining({ kind: 'pair_not_observed', symbol: pair.symbol,
      reasons: ['pair_absent_from_current_universe'] }));
    expect(added.pairs[pair.symbol].status).toBe('active');
    const returned = observeUniverse(absent.state, [pair, other], now + 240_000);
    expect(returned.newPairs).toEqual([]);
    expect(returned.state.pairs[pair.symbol]).toMatchObject({ status: 'active', firstSeenAt: now + 60_000, lastSeenAt: now + 240_000 });
  });
});

describe('injected wallet market evidence', () => {
  it('preserves the historical baseline when an unconfigured scheduler runs without network access', async () => {
    const historical = observeUniverse(createUniverseState(), [pair], now - 60_000).state;
    const runtime = { ...initialRuntime(), universe: historical, lastSuccessAt: now - 60_000 };
    const save = vi.fn(async () => undefined), release = vi.fn(async () => undefined);
    const store = { acquire: async () => ({ owner: 'isolated-test' }), runtime: async () => runtime, save, release } as unknown as DiscoveryJournal;
    expect(await runDiscovery('scheduler', { store, now: () => now })).toMatchObject({ status: 'partial', processedPairs: 0 });
    expect(runtime.universe).toBe(historical); expect(runtime.lastSuccessAt).toBe(now - 60_000);
    expect(runtime.lastError).toBe('public_wallet_market_source_missing'); expect(release).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(2); expect(fetch).not.toHaveBeenCalled();
  });
  it('reports the source as unconfigured without relabelling historical event evidence', async () => {
    const runtime = { ...initialRuntime(), lastTickAt: Date.now(), lastSuccessAt: Date.now() };
    const event = { id: 'historic-event', kind: 'baseline_created', symbol: null, observedAt: now - 60_000,
      reasons: [], evidence: { source: 'original-market-source', confirmedExecution: false } };
    const store = { runtime: async () => runtime, pairs: async () => [], events: async () => [{ event, sheetRow: 2, syncedAt: null }],
      pendingCount: async () => 1 } as unknown as DiscoveryJournal;
    const report = await discoveryReport(store);
    expect(report.source).toBe('unconfigured'); expect(report.scheduler.healthy).toBe(false);
    expect(report.recentEvents[0]).toEqual(event); expect(report.recentEvents[0].evidence.source).toBe('original-market-source');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fails closed without a source and never falls back to ambient fetch', async () => {
    await expect(readPublicUniverse()).rejects.toThrow('public_wallet_market_source_missing');
    await expect(readPublicMarket(pair)).rejects.toThrow('public_wallet_market_source_missing');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('copies validated identities, prices, source timestamps and incomplete coverage without adding evidence', async () => {
    const raw = market(), source = provider(raw), initial = structuredClone(raw);
    const universe = await readPublicUniverse(options(source)), result = await readPublicMarket(pair, options(source));
    expect(universe).toEqual([pair]); expect(universe[0]).not.toBe(pair);
    expect(result).toEqual(raw); expect(result).not.toBe(raw); expect(result.bids[0]).not.toBe(raw.bids[0]);
    expect(result.observedAt).toBe(now); expect(result.tradesComplete).toBe(false); expect(raw).toEqual(initial);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not permit an adapter to mutate the requested pair identity', async () => {
    const source: WalletDiscoverySource = { universe: async () => [pair], market: async requested => {
      requested.symbol = 'OTHER-EUR'; requested.base = 'OTHER'; return { ...market(), symbol: requested.symbol, base: requested.base };
    } };
    await expect(readPublicMarket(pair, options(source))).rejects.toThrow('public_wallet_market_identity_mismatch');
    expect(pair.symbol).toBe('NEW-EUR');
  });
  it.each(([
    [], [pair, pair], Array.from({ length: 10001 }, () => pair),
    [{ ...pair, symbol: 'OTHER-EUR' }], [{ ...pair, baseStep: 0 }], [{ ...pair, minOrderSizeQuote: Number.NaN }],
    [{ ...pair, maxOrderSize: 0.000001 }], [{ ...pair, status: 'https://private.invalid' }],
  ] satisfies MarketPair[][]).map(pairs => ({ pairs })))('rejects an incomplete, conflicting, oversized or invalid universe', async ({ pairs }) => {
    const source = { ...provider(), universe: async () => pairs };
    await expect(readPublicUniverse(options(source))).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects a snapshot for another token or quote', async () => {
    await expect(readPublicMarket(pair, options(provider({ ...market(), base: 'OTHER' })))).rejects.toThrow('public_wallet_market_identity_mismatch');
    await expect(readPublicMarket(pair, options(provider({ ...market(), quote: 'USD' })))).rejects.toThrow('public_wallet_market_identity_mismatch');
  });
  it.each([now + 1, now - 120001, 1, Number.POSITIVE_INFINITY])('rejects invalid or stale observation time %s without replacing it with local time', async observedAt => {
    await expect(readPublicMarket(pair, options(provider({ ...market(), observedAt })))).rejects.toThrow('public_wallet_market_timestamp_invalid');
  });
  it.each([now + 1, now - 120001])('rejects future or stale order-book evidence %s', async bookAt => {
    await expect(readPublicMarket(pair, options(provider({ ...market(), bookAt })))).rejects.toThrow('public_wallet_market_timestamp_invalid');
  });
  it('rejects undated, crossed, duplicated or oversized order-book depth', async () => {
    const examples = [
      { ...market(), bookAt: null },
      { ...market(), bids: [{ price: 2, quantity: 1 }] },
      { ...market(), bids: [{ price: 0.999, quantity: 1 }, { price: 0.999, quantity: 100 }] },
      { ...market(), asks: Array.from({ length: 193 }, (_, i) => ({ price: 1 + i, quantity: 1 })) },
    ];
    for (const value of examples) await expect(readPublicMarket(pair, options(provider(value)))).rejects.toThrow();
  });
  it('sorts levels and deduplicates identical trade IDs without inflating volume', async () => {
    const raw = market(); raw.bids = [{ price: 0.998, quantity: 10 }, ...raw.bids]; raw.trades.push({ ...raw.trades[0] });
    const result = await readPublicMarket(pair, options(provider(raw)));
    expect(result.bids.map(level => level.price)).toEqual([0.999, 0.998]); expect(result.trades).toHaveLength(1);
    expect(result.tradesComplete).toBe(false);
  });
  it('rejects conflicting trade IDs, invalid sides, future trades and excessive pages', async () => {
    const original = market(), item = original.trades[0];
    const examples = [
      { ...original, trades: [item, { ...item, quantity: 6 }] },
      { ...original, trades: [{ ...item, side: 'transfer' as 'buy' }] },
      { ...original, trades: [{ ...item, timestamp: now + 1 }] },
      { ...original, trades: Array.from({ length: 101 }, () => item) },
    ];
    for (const value of examples) await expect(readPublicMarket(pair, options(provider(value)))).rejects.toThrow();
  });
  it('rejects mismatched quote evidence and non-finite values', async () => {
    const raw = market();
    for (const value of [
      { ...raw, ticker: { ...raw.ticker!, bid: 2 } },
      { ...raw, ticker: { ...raw.ticker!, timestamp: now + 1 } },
      { ...raw, ticker: { ...raw.ticker!, quoteVolume24h: -1 } },
      { ...raw, asks: [{ price: Number.NaN, quantity: 1 }] },
    ]) await expect(readPublicMarket(pair, options(provider(value)))).rejects.toThrow();
  });
  it('retains missing evidence as unavailable and sanitizes provider diagnostics', async () => {
    const raw: MarketSnapshot = { ...market(), bookAt: null, bids: [], asks: [], trades: [], ticker: null,
      tradesComplete: false, issues: ['https://provider.invalid/?secret=private-value'] };
    const result = await readPublicMarket(pair, options(provider(raw)));
    expect(result).toMatchObject({ bookAt: null, bids: [], asks: [], trades: [], ticker: null, tradesComplete: false,
      issues: ['public_wallet_market_evidence_incomplete'] });
    expect(JSON.stringify(result)).not.toContain('private-value');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not expose raw adapter failures or return fabricated quotes', async () => {
    const source = { universe: async () => { throw new Error('https://private.invalid/?secret=value'); }, market: async () => {
      throw new Error('API key private-value');
    } };
    await expect(readPublicUniverse(options(source))).rejects.toThrow('public_wallet_market_source_unavailable');
    await expect(readPublicMarket(pair, options(source))).rejects.toThrow('public_wallet_market_source_unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('enforces a deadline even when an adapter never settles', async () => {
    vi.useFakeTimers();
    const source = { ...provider(), universe: () => new Promise<MarketPair[]>(() => undefined) };
    const pending = expect(readPublicUniverse({ ...options(source), timeoutMs: 100 })).rejects.toThrow('public_wallet_market_source_timeout');
    await vi.advanceTimersByTimeAsync(101); await pending; expect(fetch).not.toHaveBeenCalled();
  });
});

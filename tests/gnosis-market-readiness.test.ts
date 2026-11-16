import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../src/lib/execution/v1/model';
import { auditGnosisMarketReadiness } from '../src/lib/wallet/gnosis-market-readiness';
import { GNOSIS_MARKET_PROVIDER, GNOSIS_REFERENCE_IDENTITY, gnosisEurSeriesDigest, type GnosisEurStateSeries,
  type GnosisEurStateStore, type GnosisMarketClient, type GnosisMarketOptions } from '../src/lib/wallet/gnosis-market';

// Synthetic external market-port evidence tests the preflight boundary. These
// prices, blocks and bars claim no real liquidity, capital or financial cycle.
const NOW = 1794790000, CLOSE = Math.floor(NOW / 900) * 900, hash = '0x' + 'a'.repeat(64);
function series(count = 1000, close = CLOSE): GnosisEurStateSeries {
  const bars = Array.from({ length: count }, (_, i) => {
    const at = close - (count - i - 1) * 900;
    return { source: CONFIG.candleSource, symbol: 'WETH-EUR', openTime: at - 900, closeTime: at,
      open: '100', high: '100', low: '100', close: '100', volume: '0', complete: true };
  });
  const marks = bars.map(b => ({ at: b.closeTime, wethEur: '100', usdceEur: '0.92', xdaiEur: '0.91',
    eurUsdRoundId: '1', usdcUsdRoundId: '2', eurUsdUpdatedAt: b.closeTime - 10, usdcUsdUpdatedAt: b.closeTime - 10 }));
  const coverage: GnosisEurStateSeries['coverage'] = { identity: GNOSIS_REFERENCE_IDENTITY, state: hash, stable: hash, oracle: hash,
    bridgeReference: 'explicit-transmuter-underlying-reference-not-spot-peg', composition: 'chronological-block-and-global-log-index', finalized: true };
  return { version: 1, method: GNOSIS_MARKET_PROVIDER, chainId: 100, referenceOnly: true, executionReady: false, intervalSeconds: 900,
    bars, marks, coverage, provenanceId: gnosisEurSeriesDigest({ bars, marks, coverage }) };
}
function chunks(s: GnosisEurStateSeries) {
  return Array.from({ length: Math.ceil(s.bars.length / 200) }, (_, i) => {
    const part = { ...s, bars: s.bars.slice(i * 200, (i + 1) * 200), marks: s.marks.slice(i * 200, (i + 1) * 200) };
    return { ...part, provenanceId: gnosisEurSeriesDigest(part) };
  });
}
function fixture() {
  let now = NOW;
  const history = vi.fn(async () => series());
  const current = vi.fn<() => ReturnType<GnosisMarketClient['currentReference']>>(async () => ({
    block: { number: '49300370', hash: hash as `0x${string}`, parentHash: hash as `0x${string}`, timestamp: now }, readAt: now,
    wethEur: '100', usdceEur: '0.92', xdaiEur: '0.91', sourceId: 'gnosis-eur:current:v1:' + hash,
    fundingSourceId: 'gnosis-eur:funding:v1:' + hash, referenceOnly: true, executionReady: false }));
  const store = { load: vi.fn<GnosisEurStateStore['load']>(async () => []), save: vi.fn<GnosisEurStateStore['save']>(async () => {}) };
  const createMarket = vi.fn((_options: GnosisMarketOptions) => ({ referenceSeries: history, currentReference: current }));
  return { history, current, store, createMarket, setNow: (n: number) => { now = n; },
    deps: { store, createMarket, clock: () => now } };
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('no external network in preflight unit tests'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Gnosis reference-only preflight with no execution prerequisites', () => {
  it('requires 1000 actual contiguous completed reference bars and a fresh current block, without certifying finance', async () => {
    const f = fixture(), result = await auditGnosisMarketReadiness(f.deps);
    expect(result).toMatchObject({ status: 'ready', chainId: 100, referenceOnly: true, financialReadiness: 'not-certified', createdExecutionState: false,
      history: { completedCandles: 1000, contiguousCandles: 1000, complete: true, firstCloseTime: CLOSE - 999 * 900, lastCloseTime: CLOSE },
      current: { status: 'ready', block: { number: '49300370' }, sourceAt: NOW, readAt: NOW, usdceEur: '0.92', xdaiEur: '0.91' }, errors: [] });
    expect(result.retryAt).toBe(NOW + 300); expect(result.providerRetryAt).toBeNull(); expect(f.history).toHaveBeenCalledExactlyOnceWith(NOW, null);
    expect(f.store.save).not.toHaveBeenCalled(); expect(f.store.load).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/executor|signature|balance|grant|privateKey|executionArmed/);
  });
  it('reports only independently stored finalized progress and holes after an interrupted warmup', async () => {
    const f = fixture(), partial = series(200); f.history.mockRejectedValue(new Error('interrupted source'));
    f.store.load.mockResolvedValue(chunks(partial)); const result = await auditGnosisMarketReadiness(f.deps);
    expect(result).toMatchObject({ status: 'warming', history: { completedCandles: 200, contiguousCandles: 200, complete: false, lastCloseTime: CLOSE },
      current: { status: 'ready' }, errors: ['wallet_market_readiness_history_unavailable'] });
    expect(f.store.load).toHaveBeenCalledExactlyOnceWith({ intervalSeconds: 900, startExclusive: CLOSE - 1000 * 900, endInclusive: CLOSE });
    const old = series(200, CLOSE - 900); f.store.load.mockResolvedValue(chunks(old));
    expect((await auditGnosisMarketReadiness(f.deps)).history).toMatchObject({ completedCandles: 200, contiguousCandles: 0, lastCloseTime: CLOSE - 900 });
  });
  it.each(['gap', 'partial', 'future', 'old-close', 'unfinalized', 'wrong-chain', 'wrong-method', 'price', 'digest'] as const)(
    'does not report readiness for %s history or invent missing bars', async field => {
      const f = fixture(), value = series();
      if (field === 'gap') value.bars[500].openTime -= 900;
      if (field === 'partial') Object.assign(value.bars[0], { complete: false });
      if (field === 'future') value.bars.at(-1)!.closeTime += 900;
      if (field === 'old-close') Object.assign(value, series(1000, CLOSE - 900));
      if (field === 'unfinalized') Object.assign(value.coverage, { finalized: false });
      if (field === 'wrong-chain') Object.assign(value, { chainId: 1 });
      if (field === 'wrong-method') Object.assign(value, { method: 'paper-discovery' });
      if (field === 'price') value.marks[500].wethEur = '101';
      if (field === 'digest') value.provenanceId = ('0x' + 'b'.repeat(64)) as `0x${string}`;
      f.history.mockResolvedValue(value); const result = await auditGnosisMarketReadiness(f.deps);
      expect(result.status).not.toBe('ready'); expect(result.history.complete).toBe(false); expect(result.history.completedCandles).toBe(0);
      expect(result.errors).toContain('wallet_market_readiness_history_unavailable');
    });
  it('preserves known history while current evidence is missing, stale or changed to another reference', async () => {
    const f = fixture(), valid = await f.current();
    for (const value of [{ ...valid, readAt: NOW - 16 }, { ...valid, block: { ...valid.block, timestamp: NOW - 16 } },
      { ...valid, sourceId: 'coinbase' }, { ...valid, usdceEur: '0' }, { ...valid, referenceOnly: false }]) {
      f.current.mockResolvedValue(value as typeof valid); const result = await auditGnosisMarketReadiness(f.deps);
      expect(result).toMatchObject({ status: 'warming', history: { complete: true, completedCandles: 1000 }, current: { status: 'unavailable' } });
    }
  });
  it('bounds a hung history read, aborts its fetch context and ignores a late complete result', async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW * 1000); const f = fixture(); let finish!: (s: GnosisEurStateSeries) => void;
    f.history.mockImplementation(() => new Promise(resolve => { finish = resolve; })); f.store.load.mockResolvedValue(chunks(series(100)));
    const run = auditGnosisMarketReadiness(f.deps); await vi.advanceTimersByTimeAsync(40000);
    const result = await run; expect(result).toMatchObject({ status: 'warming', history: { completedCandles: 100, complete: false } });
    expect(result.errors).toContain('wallet_market_readiness_history_timeout');
    const fetcher = f.createMarket.mock.calls[0][0].fetch!;
    await expect(fetcher('https://rpc.gnosischain.com')).rejects.toThrow('wallet_market_readiness_aborted');
    finish(series()); await Promise.resolve(); expect(result.history.complete).toBe(false); expect(f.store.save).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds unavailable progress and current reads independently and returns unknown counts, never fake zero', async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW * 1000); const f = fixture();
    f.history.mockRejectedValue(new Error('private RPC URL')); f.store.load.mockImplementation(() => new Promise(() => {})); f.current.mockImplementation(() => new Promise(() => {}));
    const run = auditGnosisMarketReadiness(f.deps); await vi.advanceTimersByTimeAsync(11000); const result = await run;
    expect(result).toMatchObject({ status: 'unavailable', history: { completedCandles: null, contiguousCandles: null, complete: false }, current: { status: 'unavailable' } });
    expect(result.errors).toEqual(['wallet_market_readiness_history_unavailable', 'wallet_market_readiness_cache_timeout', 'wallet_market_readiness_reference_timeout']);
    expect(JSON.stringify(result)).not.toContain('private RPC URL'); expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects revised cached overlaps and preserves quarantine failures without financial fallback', async () => {
    const f = fixture(); f.history.mockRejectedValue({ code: 'gnosis_market_cache_conflict' });
    f.store.load.mockRejectedValue({ code: 'gnosis_market_cache_conflict' });
    const result = await auditGnosisMarketReadiness(f.deps);
    expect(result.errors).toEqual(['gnosis_market_cache_conflict']); expect(result.history.completedCandles).toBeNull();
    const a = series(100), b = structuredClone(a); b.bars[0].open = b.bars[0].high = b.bars[0].low = b.bars[0].close = '101'; b.marks[0].wethEur = '101'; b.provenanceId = gnosisEurSeriesDigest(b);
    f.store.load.mockResolvedValue([a, b]); expect((await auditGnosisMarketReadiness(f.deps)).history.completedCandles).toBeNull();
  });
  it('does not move a prior finalized close to the just-closed unfinalized interval', async () => {
    const f = fixture(); f.history.mockRejectedValue({ code: 'gnosis_pool_not_finalized' }); f.store.load.mockResolvedValue(chunks(series(200, CLOSE - 900)));
    const result = await auditGnosisMarketReadiness(f.deps); expect(result.history).toMatchObject({ lastCloseTime: CLOSE - 900, complete: false, contiguousCandles: 0 });
    expect(result.errors).toContain('gnosis_pool_not_finalized'); expect(result.status).toBe('warming');
  });
  it('rechecks current freshness and newest interval after the final awaited read', async () => {
    const f = fixture(), initial = await f.current();
    let clockReads = 0; const result = await auditGnosisMarketReadiness({ ...f.deps, clock: () => ++clockReads < 3 ? NOW : NOW + 901 });
    expect(result.status).not.toBe('ready'); expect(result.errors).toContain('wallet_market_readiness_history_stale');
    expect(result.current.status).toBe('unavailable'); expect(initial.readAt).toBe(NOW);
  });
  it('honors provider cooldown across the independent current phase instead of issuing a fresh class request', async () => {
    const f = fixture(); f.history.mockRejectedValue({ code: 'gnosis_market_provider_cooldown', retryAt: NOW + 1800 });
    f.store.load.mockResolvedValue(chunks(series(200))); const result = await auditGnosisMarketReadiness(f.deps);
    expect(result).toMatchObject({ retryAt: NOW + 1800, providerRetryAt: NOW + 1800, current: { status: 'unavailable' }, history: { completedCandles: 200 } });
    expect(result.errors).toEqual(['gnosis_market_provider_cooldown']); expect(f.current).not.toHaveBeenCalled();
    expect(f.createMarket).toHaveBeenCalledOnce();
  });
  it.each([Number.MAX_SAFE_INTEGER, 253402300800, NaN, undefined, NOW - 1])('holds an unusable retryAt=%s terminally without a new public read', async retryAt => {
    const f = fixture(); f.history.mockRejectedValue({ code: 'gnosis_market_provider_cooldown', retryAt });
    const result = await auditGnosisMarketReadiness(f.deps);
    expect(result.retryAt).toBe(253402300799); expect(result.errors).toContain('wallet_market_readiness_retry_invalid');
    expect(result.status).not.toBe('ready'); expect(f.current).not.toHaveBeenCalled();
  });
  it('preserves a legitimate 48-hour Retry-After instead of shortening it to one day', async () => {
    const f = fixture(); f.history.mockRejectedValue({ code: 'gnosis_market_provider_cooldown', retryAt: NOW + 172800 });
    expect((await auditGnosisMarketReadiness(f.deps)).retryAt).toBe(NOW + 172800); expect(f.current).not.toHaveBeenCalled();
  });
});

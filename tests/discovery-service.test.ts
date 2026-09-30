import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { closeDatabase, ensureSchema, query } from '../src/lib/db';
import { DiscoveryJournal, type StoredEvent } from '../src/lib/discovery/journal';
import { discoveryReport, runDiscovery } from '../src/lib/discovery/service';
import type { MarketPair, MarketSnapshot } from '../src/lib/discovery/model';
import { DISCOVERY_SHEET, sheetEventRow, syncSheetEvents } from '../src/lib/discovery/sheets';

const start = Date.parse('2026-10-01T08:00:00Z');
const pair = (base: string): MarketPair => ({ symbol: `${base}-EUR`, base, quote: 'EUR', status: 'active',
  baseStep: 0.01, minOrderSize: 0.01, minOrderSizeQuote: 1, maxOrderSize: null });
function unavailable(p: MarketPair, at: number): MarketSnapshot {
  return { symbol: p.symbol, base: p.base, quote: p.quote, observedAt: at, bookAt: null, bids: [], asks: [],
    trades: [], ticker: null, issues: ['book:public_request_timeout'], tradesComplete: false };
}
function available(p: MarketPair, at: number): MarketSnapshot {
  return { symbol: p.symbol, base: p.base, quote: p.quote, observedAt: at, bookAt: at, bids: [{ price: 9.99, quantity: 100 }],
    asks: [{ price: 10, quantity: 100 }], trades: [{ id: `trade:${at}`, price: 10, quantity: 10, timestamp: at, side: 'buy' }],
    ticker: { bid: 9.99, ask: 10, last: 10, quoteVolume24h: 1000, timestamp: at }, issues: [], tradesComplete: true };
}
async function financialRows() {
  return (await query<{ count: string }>('SELECT ((SELECT COUNT(*) FROM order_intents)+(SELECT COUNT(*) FROM broker_credentials))::text AS count')).rows[0].count;
}
beforeAll(async () => {
  await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL', ''); vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); await ensureSchema();
});
beforeEach(async () => {
  await query('TRUNCATE app_settings');
  vi.stubEnv('DISCOVERY_GOOGLE_SERVICE_EMAIL', ''); vi.stubEnv('DISCOVERY_GOOGLE_PRIVATE_KEY', '');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request in an isolated discovery test'); }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });

describe('paper discovery orchestration and outbox', () => {
  it('establishes a baseline without fabricating new pairs, paper entries, or financial records', async () => {
    const store = new DiscoveryJournal(), universe = vi.fn(async () => [pair('BTC'), pair('ETH')]), market = vi.fn();
    const before = await financialRows();
    expect(await runDiscovery('scheduler', { store, universe, market, now: () => start })).toMatchObject({ status: 'completed', observedPairs: 2, processedPairs: 0 });
    expect(market).not.toHaveBeenCalled(); expect(await store.pairs()).toEqual([]);
    const report = await discoveryReport(store);
    expect(report.baselineAt).toBe(start); expect(report.universe.total).toBe(2);
    expect(report.recentEvents.map(e => e.kind)).toEqual(['baseline_created']);
    expect((await store.runtime()).lastTickAt).toBe(start); expect(await financialRows()).toBe(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('records a later first appearance once and retains missing market evidence without a fabricated fill', async () => {
    const store = new DiscoveryJournal(); let at = start;
    const universe = vi.fn().mockResolvedValueOnce([pair('BTC')]).mockResolvedValue([pair('BTC'), pair('NEW')]);
    const market = vi.fn(async (p: MarketPair) => unavailable(p, at));
    await runDiscovery('scheduler', { store, universe, market, now: () => at }); at += 60000;
    expect(await runDiscovery('scheduler', { store, universe, market, now: () => at })).toMatchObject({ status: 'partial' });
    const states = await store.pairs(); expect(states.map(p => p.symbol)).toEqual(['NEW-EUR']);
    expect(states[0].simulations.every(s => s.entry === null && s.confirmedExecution === false)).toBe(true);
    expect((await store.events()).filter(r => r.event.kind === 'newly_observed')).toHaveLength(1);
    expect((await store.runtime()).lastSuccessAt).toBe(start);
    expect((await store.runtime()).lastError).not.toBeNull();
    const rows = (await store.events()).map(r => [r.event.id, r.sheetRow]);
    expect(await runDiscovery('manual', { store, universe, market, now: () => at + 1000 })).toMatchObject({ status: 'throttled' });
    expect((await store.events()).map(r => [r.event.id, r.sheetRow])).toEqual(rows);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not create a baseline from an empty initial response', async () => {
    const store = new DiscoveryJournal(), universe = vi.fn(async () => []), market = vi.fn();
    expect(await runDiscovery('scheduler', { store, universe, market, now: () => start })).toMatchObject({ status: 'partial' });
    const runtime = await store.runtime(); expect(runtime.universe.baselineAt).toBeNull(); expect(runtime.universe.pairs).toEqual({});
    expect(runtime.lastSuccessAt).toBeNull(); expect(await store.pairs()).toEqual([]); expect(market).not.toHaveBeenCalled();
    expect((await store.events()).some(r => r.event.kind === 'baseline_created')).toBe(false);
  });

  it('does not keep a disappeared pair eligible using its earlier active metadata', async () => {
    const store = new DiscoveryJournal(); let at = start;
    const universe = vi.fn().mockResolvedValueOnce([pair('BTC')]).mockResolvedValueOnce([pair('BTC'), pair('NEW')]).mockResolvedValue([pair('BTC')]);
    const market = vi.fn(async (p: MarketPair) => at === start + 60000 ? unavailable(p, at) : available(p, at));
    await runDiscovery('scheduler', { store, universe, market, now: () => at }); at += 60000;
    await runDiscovery('scheduler', { store, universe, market, now: () => at }); at += 60000;
    await runDiscovery('scheduler', { store, universe, market, now: () => at });
    const state = (await store.pairs())[0];
    expect(state.simulations.every(s => s.entry === null)).toBe(true);
    expect(state.simulations.find(s => s.strategy === 'delayed')).toMatchObject({ status: 'rejected', reasons: expect.arrayContaining(['pair_not_active']) });
  });

  it('preserves the last good universe and last success after a failed provider read, without leaking its error', async () => {
    const store = new DiscoveryJournal(), universe = vi.fn(async () => [pair('BTC')]);
    await runDiscovery('scheduler', { store, universe, now: () => start });
    const before = await store.runtime();
    universe.mockRejectedValueOnce(new Error('https://provider.invalid/?secret=private-value'));
    expect(await runDiscovery('scheduler', { store, universe, now: () => start + 60000 })).toMatchObject({ status: 'partial' });
    const failed = await store.runtime();
    expect(failed.universe).toEqual(before.universe); expect(failed.lastSuccessAt).toBe(before.lastSuccessAt);
    expect(failed.lastError).toBe('discovery_source_unavailable');
    expect(JSON.stringify(await store.events())).not.toContain('private-value');
    expect(await runDiscovery('scheduler', { store, universe, now: () => start + 120000 })).toMatchObject({ status: 'completed' });
    expect((await store.runtime()).lastError).toBeNull();
  });

  it.each(['empty', 'shrink'])('does not report a rejected %s universe as a successful scan', async mode => {
    const store = new DiscoveryJournal(), original = Array.from({ length: 12 }, (_, i) => pair(`P${i}`));
    const universe = vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(mode === 'empty' ? [] : original.slice(0, 2));
    await runDiscovery('scheduler', { store, universe, now: () => start });
    const before = await store.runtime();
    expect(await runDiscovery('scheduler', { store, universe, now: () => start + 60000 })).toMatchObject({ status: 'partial' });
    const after = await store.runtime(); expect(after.universe).toEqual(before.universe);
    expect(after.lastSuccessAt).toBe(start); expect(after.lastError).not.toBeNull();
    expect((await store.events()).some(r => r.event.kind === 'universe_rejected')).toBe(true);
  });

  it('gives later pairs a turn when earlier market requests keep throwing', async () => {
    const store = new DiscoveryJournal(); let at = start;
    const universe = vi.fn().mockResolvedValueOnce([pair('BTC')]).mockResolvedValue([pair('BTC'), pair('AAA'), pair('BBB'), pair('CCC')]);
    const market = vi.fn(async (p: MarketPair) => { if (p.base !== 'CCC') throw new Error('public_request_timeout'); return unavailable(p, at); });
    await runDiscovery('scheduler', { store, universe, market, now: () => at }); at += 60000;
    await runDiscovery('scheduler', { store, universe, market, now: () => at }); at += 60000;
    await runDiscovery('scheduler', { store, universe, market, now: () => at });
    expect(market.mock.calls.some(([p]) => p.symbol === 'CCC-EUR')).toBe(true);
    expect((await store.events()).some(r => r.event.kind === 'market_read_failed')).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a partial run with zero processed pairs when the time budget expires before the first market attempt', async () => {
    const store = new DiscoveryJournal(); let at = start;
    await runDiscovery('scheduler', { store, universe: async () => [pair('BTC')], now: () => at });
    at += 60000;
    const universe = vi.fn(async () => { at += 8001; return [pair('BTC'), pair('NEW')]; });
    const market = vi.fn(async (p: MarketPair) => available(p, at));
    expect(await runDiscovery('scheduler', { store, universe, market, now: () => at })).toMatchObject({ status: 'partial', processedPairs: 0 });
    expect(market).not.toHaveBeenCalled();
    const runtime = await store.runtime(); expect(runtime.lastSuccessAt).toBe(start); expect(runtime.lastError).not.toBeNull();
    const state = (await store.pairs())[0]; expect(state.symbol).toBe('NEW-EUR'); expect(state.lastObservedAt).toBeNull();
    expect(state.simulations.every(s => s.status === 'waiting' && s.entry === null)).toBe(true);
    expect((await store.events()).some(r => r.event.kind === 'market_budget_deferred')).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports an overloaded candidate list as partial, counts only attempts, and rotates the deferred pair into the next run', async () => {
    const store = new DiscoveryJournal(); let at = start;
    const universe = vi.fn().mockResolvedValueOnce([pair('BTC')]).mockResolvedValue([pair('BTC'), pair('AAA'), pair('BBB'), pair('CCC')]);
    const market = vi.fn(async (p: MarketPair) => available(p, at));
    await runDiscovery('scheduler', { store, universe, market, now: () => at }); at += 60000;
    expect(await runDiscovery('scheduler', { store, universe, market, now: () => at })).toMatchObject({ status: 'partial', processedPairs: 2 });
    expect(market).toHaveBeenCalledTimes(2); expect(await store.pairs()).toHaveLength(3);
    const deferred = (await store.pairs()).find(p => p.lastObservedAt === null)!; expect(deferred).toBeDefined();
    expect((await store.runtime()).lastSuccessAt).toBe(start);
    expect((await store.events()).some(r => r.event.kind === 'market_budget_deferred')).toBe(true);
    at += 60000;
    expect(await runDiscovery('scheduler', { store, universe, market, now: () => at })).toMatchObject({ status: 'partial', processedPairs: 2 });
    expect(market).toHaveBeenCalledTimes(4); expect(market.mock.calls[2][0].symbol).toBe(deferred.symbol);
    expect((await store.pairs()).find(p => p.symbol === deferred.symbol)?.lastObservedAt).toBe(at);
    expect((await store.runtime()).lastSuccessAt).toBe(start); expect(fetch).not.toHaveBeenCalled();
  });

  it('retains unsent records after a Sheet failure and retries the same row after recovery', async () => {
    vi.stubEnv('DISCOVERY_GOOGLE_SERVICE_EMAIL', 'test@example.invalid'); vi.stubEnv('DISCOVERY_GOOGLE_PRIVATE_KEY', 'isolated-test-placeholder');
    const store = new DiscoveryJournal(), universe = vi.fn(async () => [pair('BTC')]);
    const sync = vi.fn().mockRejectedValueOnce(new Error('provider error includes PRIVATE_GOOGLE_TOKEN')).mockResolvedValue(undefined);
    const before = await financialRows();
    await runDiscovery('scheduler', { store, universe, sync, now: () => start });
    expect(await store.pendingCount()).toBe(1); expect((await store.runtime()).sync.lastError).toBe('discovery_source_unavailable');
    const first = structuredClone(sync.mock.calls[0][0]);
    await runDiscovery('scheduler', { store, universe, sync, now: () => start + 60000 });
    expect(sync.mock.calls[1][0]).toEqual(first); expect(await store.pendingCount()).toBe(0);
    expect((await store.runtime()).sync).toEqual({ lastSuccessAt: start + 60000, lastError: null });
    expect(await store.events()).toHaveLength(1); expect(await financialRows()).toBe(before); expect(fetch).not.toHaveBeenCalled();
  });

  it('replays a deterministic Sheet row when the write succeeded but its database acknowledgment failed', async () => {
    vi.stubEnv('DISCOVERY_GOOGLE_SERVICE_EMAIL', 'test@example.invalid'); vi.stubEnv('DISCOVERY_GOOGLE_PRIVATE_KEY', 'isolated-test-placeholder');
    const store = new DiscoveryJournal(), universe = vi.fn(async () => [pair('BTC')]), sync = vi.fn(async () => undefined);
    vi.spyOn(store, 'acknowledge').mockRejectedValueOnce(new Error('sheets_ack_failed'));
    await runDiscovery('scheduler', { store, universe, sync, now: () => start });
    expect(await store.pendingCount()).toBe(1); expect((await store.runtime()).sync.lastError).toBe('sheets_ack_failed');
    await runDiscovery('scheduler', { store, universe, sync, now: () => start + 60000 });
    expect(sync).toHaveBeenCalledTimes(2); expect(sync.mock.calls[1]).toEqual(sync.mock.calls[0]);
    expect(await store.pendingCount()).toBe(0); expect(await store.events()).toHaveLength(1);
  });

  it('performs no source or Sheet work while another process owns the database lease', async () => {
    const store = new DiscoveryJournal(), lease = (await store.acquire())!, universe = vi.fn(), market = vi.fn(), sync = vi.fn();
    expect(await runDiscovery('scheduler', { store, universe, market, sync, now: () => start })).toEqual({ status: 'busy' });
    expect(universe).not.toHaveBeenCalled(); expect(market).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled();
    expect((await store.runtime()).lastRunAt).toBeNull(); await store.release(lease);
  });
});

describe('Google Sheets export with isolated transport', () => {
  let privateKey = '', emailId = 0;
  const record = (row = 2): StoredEvent => ({ sheetRow: row, syncedAt: null,
    event: { id: `paper-event-${row}`, symbol: 'NEW-EUR', kind: 'newly_observed', observedAt: start,
      reasons: [], evidence: { confirmedExecution: false } } });
  beforeAll(() => {
    privateKey = generateKeyPairSync('rsa', { modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  });
  beforeEach(() => {
    vi.stubEnv('DISCOVERY_GOOGLE_SERVICE_EMAIL', `isolated-${++emailId}@example.invalid`);
    vi.stubEnv('DISCOVERY_GOOGLE_PRIVATE_KEY', privateKey);
  });
  function transport(rows = new Map<number, unknown[]>(), options: { unknownFirstWrite?: boolean; corruptReadback?: boolean } = {}) {
    let writes = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      if (url.origin === 'https://oauth2.googleapis.com') return Response.json({ access_token: 'isolated-access-token', token_type: 'Bearer', expires_in: 3600 });
      if (url.origin !== 'https://sheets.googleapis.com') throw new Error('Unexpected destination in Sheet test');
      if (url.pathname.endsWith('/values:batchGet')) return Response.json({ valueRanges: url.searchParams.getAll('ranges').map(range => {
        const match = /!A(\d+):J\d+$/.exec(range); if (!match) throw new Error('Unexpected Sheet range');
        const row = rows.get(Number(match[1])); return { range, ...(row ? { values: [row] } : {}) };
      }) });
      if (url.pathname.endsWith('/values:batchUpdate')) {
        writes++;
        const body = JSON.parse(String(init?.body)); expect(body.valueInputOption).toBe('RAW');
        for (const entry of body.data) {
          const row = Number(/!A(\d+):J\d+$/.exec(entry.range)![1]); rows.set(row, entry.values[0]);
          if (options.corruptReadback) rows.get(row)![3] = 'wrong-value-after-write';
        }
        if (options.unknownFirstWrite && writes === 1) return new Response('private provider failure', { status: 503 });
        return Response.json({ totalUpdatedRows: body.data.length });
      }
      return Response.json({ sheets: [{ properties: { title: DISCOVERY_SHEET, sheetId: 900, gridProperties: { rowCount: 1000 } } }] });
    });
    return { fetcher, rows, writes: () => writes };
  }

  it.each([{ existing: ['older-event'] }, { existing: ['', 'existing user note'] }])('refuses to replace occupied rows owned by other content', async ({ existing }) => {
    const mock = transport(new Map([[2, existing]]));
    await expect(syncSheetEvents([record()], mock.fetcher)).rejects.toThrow('sheets_row_conflict');
    expect(mock.writes()).toBe(0); expect(mock.rows.get(2)).toEqual(existing); expect(fetch).not.toHaveBeenCalled();
  });

  it('retries an unknown write into the same row and verifies its complete contents before success', async () => {
    const mock = transport(undefined, { unknownFirstWrite: true });
    await expect(syncSheetEvents([record()], mock.fetcher)).rejects.toThrow('sheets_write_http_503');
    expect(mock.rows.get(2)).toEqual(sheetEventRow(record()));
    await syncSheetEvents([record()], mock.fetcher);
    expect(mock.writes()).toBe(2); expect(mock.rows.size).toBe(1); expect(mock.rows.get(2)).toEqual(sheetEventRow(record()));
    expect(String(mock.fetcher.mock.calls.at(-1)?.[0])).toContain('/values:batchGet');
    expect(mock.fetcher.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true); expect(fetch).not.toHaveBeenCalled();
  });

  it('does not acknowledge an HTTP-successful write whose readback differs', async () => {
    const mock = transport(undefined, { corruptReadback: true });
    await expect(syncSheetEvents([record()], mock.fetcher)).rejects.toThrow();
    expect(mock.writes()).toBe(1); expect(String(mock.fetcher.mock.calls.at(-1)?.[0])).toContain('/values:batchGet');
  });

  it.each([{ rows: [1] }, { rows: [0] }, { rows: [2, 2] }])('rejects header writes or duplicate assigned rows before contacting Google', async ({ rows }) => {
    const mock = transport();
    await expect(syncSheetEvents(rows.map(row => record(row)), mock.fetcher)).rejects.toThrow('sheets_invalid_rows');
    expect(mock.fetcher).not.toHaveBeenCalled();
  });

  it('shares one seven-second deadline across authentication, reads and the pending write', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms); return controller.signal;
    });
    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const url = String(input), signal = init?.signal;
      if (signal?.aborted) { reject(signal.reason); return; }
      const timer = setTimeout(() => {
        if (url.startsWith('https://oauth2.googleapis.com')) resolve(Response.json({ access_token: 'deadline-test-token', token_type: 'Bearer', expires_in: 3600 }));
        else if (url.includes('/values:batchGet')) resolve(Response.json({ valueRanges: [{}] }));
        else resolve(Response.json({ sheets: [{ properties: { title: DISCOVERY_SHEET, sheetId: 900, gridProperties: { rowCount: 1000 } } }] }));
      }, url.includes('/values:batchUpdate') ? 100000 : 2000);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    }));
    const result = expect(syncSheetEvents([record()], fetcher)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(7000); await result;
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain('/values:batchUpdate');
    expect(fetcher.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
  });
});

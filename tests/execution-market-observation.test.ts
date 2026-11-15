import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, ensureSchema, query, type SqlExecutor } from '../src/lib/db';
import { CONFIG, type Candle } from '../src/lib/execution/v1/model';
import { MARKET_OBSERVATION_KEY, MARKET_OBSERVATION_LEASE_KEY, marketObservationReport, runMarketObservation } from '../src/lib/execution/v1/market-observation';
import { COINBASE_REFERENCE_PROVIDER, COINBASE_USDC, type CoinbaseMarketMapping } from '../src/lib/wallet/coinbase-market';

let now = Date.parse('2026-11-15T19:22:37Z') / 1000;
const start = now, clock = () => now;
function mapping(currency = 'AAA', n = 1): CoinbaseMarketMapping {
  const m = { version: 1 as const, chainId: 1 as const, tokenAddress: ('0x' + n.toString(16).padStart(40, '0')) as `0x${string}`,
    tokenDecimals: 18, currency, referenceCurrency: currency, symbol: currency + '-EUR', productId: currency + '-EUR',
    provider: COINBASE_REFERENCE_PROVIDER, method: 'exact-ethereum-contract-v1' as const };
  return { ...m, sourceId: 'coinbase-eur:v1:' + createHash('sha256').update(JSON.stringify([m.version, m.chainId,
    m.tokenAddress, m.tokenDecimals, m.currency, m.referenceCurrency, m.symbol, m.productId, m.provider, m.method])).digest('hex') };
}
function bars(m: CoinbaseMarketMapping, at: number, after: number | null, spike = false): Candle[] {
  const end = Math.floor(at / 900) * 900, first = after ?? end - 1000 * 900;
  return Array.from({ length: (end - first) / 900 }, (_, i) => {
    const price = spike && first + (i + 1) * 900 === end ? '120' : '100';
    return { source: CONFIG.candleSource, symbol: m.symbol, openTime: first + i * 900, closeTime: first + (i + 1) * 900,
      open: price, close: price, high: price, low: price, volume: '1', complete: true };
  });
}
function port(links = [mapping()]) {
  return { catalog: vi.fn(async () => links), candles: vi.fn(async (m: CoinbaseMarketMapping, at: number, after: number | null) => bars(m, at, after)) };
}
async function unrelated() { return (await query("SELECT key,value FROM app_settings WHERE key NOT LIKE 'market:ema-observation:%' ORDER BY key")).rows; }
async function seed(key: string, value: unknown) { await query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)', [key, JSON.stringify(value)]); }
beforeAll(async () => {
  await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL', ''); vi.stubEnv('VERCEL_ENV', '');
  vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); vi.stubEnv('MIRSAD_RETIRE_LEGACY_CONNECTION', undefined);
  await ensureSchema();
});
beforeEach(async () => {
  now = start; await query('TRUNCATE app_settings,audit_events RESTART IDENTITY');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network in observer test'); }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });

describe('independent EMA reference measurements', () => {
  it('warms the real EMA algorithm and persists a reference cross without a financial account or authority', async () => {
    const market = port(); market.candles.mockImplementation(async (m, at, after) => bars(m, at, after, true));
    const value = await runMarketObservation({ market, clock });
    expect(value).toMatchObject({ status: 'updated', report: { healthy: true, financialReadiness: 'not-certified',
      mode: 'market-reference-only', markets: [{ status: 'current', barCount: 1000, lastCloseTime: Math.floor(now / 900) * 900,
        lastPattern: { side: 'buy', at: Math.floor(now / 900) * 900, close: '120' } }] } });
    expect(Number(value.report.markets[0].ema20)).toBeGreaterThan(Number(value.report.markets[0].ema50));
    expect(Number(value.report.markets[0].ema50)).toBeGreaterThan(Number(value.report.markets[0].ema200));
    expect(await marketObservationReport(undefined, now)).toEqual(value.report);
    expect(await unrelated()).toEqual([]); expect(fetch).not.toHaveBeenCalled();
    expect((await query('SELECT * FROM audit_events')).rows).toEqual([]);
  });
  it('never changes financial switches, decisions, profiles, grants or paper discovery state', async () => {
    await seed('execution:v1:metamask-strategy-v1:state', { entriesEnabled: false, executionArmed: false, pendingSignals: [{ id: 'keep' }] });
    await seed('execution:v1:metamask-strategy-v1:decision:keep', { quantity: '1', status: 'unknown' });
    await seed('wallet:strategy:profile:v1', { unavailable: true }); await seed('wallet:authority:v1', { state: 'revoked' });
    await seed('discovery:paper:v1:state', { feeRate: '0.001', keep: true });
    const before = await unrelated();
    expect((await runMarketObservation({ market: port(), clock, trigger: 'scheduler' })).report.lastTrigger).toBe('scheduler');
    expect(await unrelated()).toEqual(before); expect(fetch).not.toHaveBeenCalled();
  });
  it('throttles new work for300 seconds and resumes from the stored last completed bar across instances', async () => {
    const market = port(); await runMarketObservation({ market, clock }); now += 299;
    expect((await runMarketObservation({ market, clock })).status).toBe('throttled'); expect(market.catalog).toHaveBeenCalledTimes(1);
    now = start + 900;
    expect((await runMarketObservation({ market, clock })).report.markets[0]).toMatchObject({ barCount: 1001, lastCloseTime: Math.floor(now / 900) * 900 });
    expect(market.candles.mock.calls[1][2]).toBe(Math.floor(start / 900) * 900);
  });
  it('retains last successful indicators while making failed contiguous coverage and stale observations visible', async () => {
    const market = port(), good = (await runMarketObservation({ market, clock })).report;
    now += 900; market.candles.mockImplementation(async (m, at, after) => bars(m, at, after).slice(1));
    const failed = (await runMarketObservation({ market, clock })).report;
    expect(failed).toMatchObject({ healthy: false, status: 'partial', lastSuccessAt: good.lastSuccessAt,
      lastError: 'market_observation_incomplete', markets: [{ status: 'incomplete', lastError: 'candle_gap',
        lastSuccessAt: good.markets[0].lastSuccessAt, barCount: 1000, ema20: good.markets[0].ema20 }] });
    expect((await marketObservationReport(undefined, now + 3600)).healthy).toBe(false);
  });
  it('rejects a999-bar warmup and an internal candle gap without manufacturing coverage', async () => {
    for (const gap of [false, true]) {
      await query('DELETE FROM app_settings'); const market = port();
      market.candles.mockImplementation(async (m, at, after) => {
        const values = bars(m, at, after); return gap ? [...values.slice(0, 500), ...values.slice(501)] : values.slice(1);
      });
      const value = await runMarketObservation({ market, clock });
      expect(value.report).toMatchObject({ healthy: false, lastSuccessAt: null, markets: [{ status: 'incomplete', barCount: 0 }] });
    }
  });
  it('warms a changed immutable mapping from1000 bars instead of inheriting the previous token indicators or pattern', async () => {
    const market = port(); market.candles.mockImplementation(async (m, at, after) => bars(m, at, after, true));
    const old = await runMarketObservation({ market, clock }); now += 900;
    market.catalog.mockResolvedValue([mapping('AAA', 2)]); market.candles.mockImplementation(async (m, at, after) => bars(m, at, after));
    const changed = await runMarketObservation({ market, clock });
    expect(market.candles.mock.calls[1][2]).toBeNull();
    expect(changed.report.markets[0]).toMatchObject({ sourceId: mapping('AAA', 2).sourceId, barCount: 1000, ema20: '100', lastPattern: null });
    expect(changed.report.markets[0].sourceId).not.toBe(old.report.markets[0].sourceId);
  });
  it('recovers after more than1000 missing intervals with a fresh warmup and no inherited pattern or EMA', async () => {
    const market = port(); market.candles.mockImplementation(async (m, at, after) => bars(m, at, after, true));
    expect((await runMarketObservation({ market, clock })).report.markets[0].lastPattern?.side).toBe('buy');
    now += 1001 * 900;
    market.candles.mockImplementation(async (m, at, after) => bars(m, at, after));
    const recovered = await runMarketObservation({ market, clock });
    expect(market.candles.mock.calls[1][2]).toBeNull();
    expect(recovered.report).toMatchObject({ healthy: true, markets: [{ barCount: 1000, ema20: '100', ema50: '100',
      ema200: '100', lastPattern: null, lastCloseTime: Math.floor(now / 900) * 900 }] });
  });
  it('rejects unsafe and future stored dates instead of returning a healthy snapshot or an invalid UI date', async () => {
    const value = await runMarketObservation({ market: port(), clock });
    const original = (await query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [MARKET_OBSERVATION_KEY])).rows[0].value;
    for (const [path, timestamp] of [['{lastSuccessAt}', Number.MAX_SAFE_INTEGER], ['{lastSuccessAt}', now + 1],
      ['{lastAttemptAt}', now + 1], ['{universeObservedAt}', now + 1], ['{markets,0,lastSuccessAt}', Number.MAX_SAFE_INTEGER],
      ['{markets,0,lastSuccessAt}', now + 1], ['{markets,0,lastAttemptAt}', now + 1]] as const) {
      await query('UPDATE app_settings SET value=$2::jsonb WHERE key=$1', [MARKET_OBSERVATION_KEY, JSON.stringify(original)]);
      await query('UPDATE app_settings SET value=jsonb_set(value,$2::text[],$3::jsonb) WHERE key=$1', [MARKET_OBSERVATION_KEY, path, String(timestamp)]);
      const report = await marketObservationReport(undefined, now);
      expect(report).toMatchObject({ status: 'unavailable', healthy: false, lastError: 'market_observation_state_invalid',
        lastSuccessAt: null, lastAttemptAt: null, universeObservedAt: null, markets: [] });
      expect(() => JSON.stringify(report)).not.toThrow();
    }
    expect(value.report.lastSuccessAt).toBe(now);
  });
  it('records the server-owned scheduler trigger separately from a manual scan and rejects arbitrary triggers', async () => {
    expect((await runMarketObservation({ market: port(), clock })).report.lastTrigger).toBe('manual'); now += 300;
    const scheduled = await runMarketObservation({ market: port(), clock, trigger: 'scheduler' });
    expect(scheduled.report).toMatchObject({ healthy: true, lastTrigger: 'scheduler', lastAttemptAt: now, lastSuccessAt: now });
    await expect(runMarketObservation({ market: port(), clock, trigger: 'owner-payload' as 'manual' })).rejects.toThrow('market_observation_trigger_invalid');
    expect(await marketObservationReport(undefined, now)).toEqual(scheduled.report);
  });
  it('samples the production report clock after a delayed read while preserving an explicit audit clock', async () => {
    await runMarketObservation({ market: port(), clock });
    const row = (await query<{ value: Record<string, unknown> }>('SELECT value FROM app_settings WHERE key=$1', [MARKET_OBSERVATION_KEY])).rows[0];
    const newer = { ...row.value, lastAttemptAt: now + 1, lastSuccessAt: now + 1, universeObservedAt: now + 1 };
    vi.useFakeTimers(); vi.setSystemTime(now * 1000);
    const delayed = { query: vi.fn(async () => { await Promise.resolve(); vi.setSystemTime((now + 1) * 1000); return { rows: [{ value: newer }], rowCount: 1 }; }) } as unknown as SqlExecutor;
    expect(await marketObservationReport(delayed)).toMatchObject({ status: 'current', healthy: true, lastSuccessAt: now + 1 });
    expect(await marketObservationReport(delayed, now)).toMatchObject({ status: 'unavailable', healthy: false, lastError: 'market_observation_state_invalid' });
  });
  it('rejects forged/wrong-chain catalogues and excludes the physical funding token', async () => {
    const market = port(); market.catalog.mockResolvedValue([{ ...mapping(), chainId: 8453 } as unknown as CoinbaseMarketMapping]);
    expect((await runMarketObservation({ market, clock })).report).toMatchObject({ healthy: false, lastError: 'market_observation_catalog_invalid', markets: [] });
    expect(market.candles).not.toHaveBeenCalled(); now += 300;
    const usdc = mapping('USDC', 3); usdc.tokenAddress = COINBASE_USDC; usdc.tokenDecimals = 6;
    usdc.sourceId = 'coinbase-eur:v1:' + createHash('sha256').update(JSON.stringify([1, 1, usdc.tokenAddress, 6, usdc.currency,
      usdc.referenceCurrency, usdc.symbol, usdc.productId, usdc.provider, usdc.method])).digest('hex');
    market.catalog.mockResolvedValue([mapping(), usdc]);
    expect((await runMarketObservation({ market, clock })).report.markets.map(m => m.symbol)).toEqual(['AAA-EUR']);
  });
  it('fairly rotates a catalogue larger than the bounded10-market run', async () => {
    const market = port(Array.from({ length: 12 }, (_, i) => mapping('AA' + String(i).padStart(2, '0'), i + 1)));
    const first = await runMarketObservation({ market, clock });
    expect(market.candles).toHaveBeenCalledTimes(10); expect(first.report.healthy).toBe(false);
    expect(first.report.markets.filter(m => m.status === 'warming')).toHaveLength(2);
    now += 300; const second = await runMarketObservation({ market, clock });
    expect(second.report.markets.every(m => m.barCount === 1000)).toBe(true); expect(second.report.healthy).toBe(true);
    expect(market.candles.mock.calls.slice(10).map(c => c[0].symbol)).toEqual(['AA10-EUR', 'AA11-EUR']);
  });
  it('serializes overlapping scans with its own lease, then fences a delayed old writer after takeover', async () => {
    let release!: (value: Candle[]) => void, entered!: () => void;
    const ready = new Promise<void>(r => { entered = r; }); const market = port();
    market.candles.mockImplementationOnce(async () => { entered(); return new Promise<Candle[]>(r => { release = r; }); });
    const old = runMarketObservation({ market, clock }); await ready;
    expect((await runMarketObservation({ market: port(), clock })).status).toBe('busy');
    now += 301;
    const replacement = await runMarketObservation({ market: port(), clock }); expect(replacement.status).toBe('updated');
    release(bars(mapping(), start, null));
    expect(await old).toMatchObject({ status: 'unavailable', reason: 'market_observation_lease_lost' });
    expect(await marketObservationReport(undefined, now)).toEqual(replacement.report);
    expect((await query('SELECT key FROM app_settings WHERE key=$1', [MARKET_OBSERVATION_LEASE_KEY])).rows).toEqual([]);
  });
  it('bounds hung source work and ignores late completion without overwriting the stored error', async () => {
    let release!: (value: Candle[]) => void; const market = port();
    market.candles.mockImplementationOnce(() => new Promise<Candle[]>(r => { release = r; }));
    const failed = await runMarketObservation({ market, clock, budgetMs: 100 });
    expect(failed.report).toMatchObject({ healthy: false, markets: [{ lastError: 'market_observation_budget_exhausted', barCount: 0 }] });
    const before = await marketObservationReport(undefined, now); release(bars(mapping(), now, null)); await new Promise(r => setTimeout(r, 1));
    expect(await marketObservationReport(undefined, now)).toEqual(before);
    now += 300; expect((await runMarketObservation({ market: port(), clock })).status).toBe('updated');
  });
  it('aborts actual provider HTTP signals at the run deadline and starts no later catalogue or candle requests', async () => {
    let aborted = false;
    const network = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('isolated abort')); }, { once: true });
    })); vi.stubGlobal('fetch', network);
    const value = await runMarketObservation({ clock, budgetMs: 50 });
    expect(value.report.healthy).toBe(false); expect(aborted).toBe(true); expect(network).toHaveBeenCalledOnce();
    await new Promise(r => setTimeout(r, 1)); expect(network).toHaveBeenCalledOnce();
    expect(JSON.stringify(value)).not.toContain('isolated abort');
  });
  it('sanitizes source exceptions, preserves prior success, and reports corrupt stored identity as unavailable', async () => {
    const market = port(), good = await runMarketObservation({ market, clock }); now += 300;
    market.catalog.mockRejectedValue(new Error('https://private.provider/?key=secret-sentinel'));
    const failed = await runMarketObservation({ market, clock });
    expect(failed.report).toMatchObject({ healthy: false, lastSuccessAt: good.report.lastSuccessAt, lastError: 'market_observation_source_unavailable' });
    expect(JSON.stringify(failed)).not.toContain('secret-sentinel');
    await query("UPDATE app_settings SET value=jsonb_set(value,'{markets,0,identity}','\"bad\"') WHERE key=$1", [MARKET_OBSERVATION_KEY]);
    expect(await marketObservationReport(undefined, now)).toMatchObject({ status: 'unavailable', healthy: false, lastError: 'market_observation_state_invalid' });
  });
  it('uses only fixed public GET catalogue/candle routes through the actual provider, without funds or financial source bootstrap', async () => {
    const link = mapping('LINK', 1), network = vi.fn<typeof fetch>(async (input, init) => {
      expect(init).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error' }); const url = new URL(String(input));
      if (url.hostname === 'raw.githubusercontent.com') return Response.json({ tokens: [{ chainId: 1, address: link.tokenAddress, decimals: 18, symbol: 'LINK' }] });
      expect(url.origin).toBe('https://api.exchange.coinbase.com');
      if (url.pathname === '/products') return Response.json([{ id: 'LINK-EUR', base_currency: 'LINK', quote_currency: 'EUR', status: 'online', trading_disabled: false, cancel_only: false, auction_mode: false }]);
      if (url.pathname === '/currencies') return Response.json([{ id: 'LINK', status: 'online', supported_networks: [{ id: 'ethereum', status: 'online', contract_address: link.tokenAddress }] }]);
      expect(url.pathname).toBe('/products/LINK-EUR/candles');
      const first = Number(url.searchParams.get('start')), end = Number(url.searchParams.get('end'));
      return Response.json(Array.from({ length: (end - first) / 900 + 1 }, (_, i) => [first + i * 900, 100, 100, 100, 100, 1]));
    }); vi.stubGlobal('fetch', network);
    expect((await runMarketObservation({ clock })).report).toMatchObject({ healthy: true, markets: [{ symbol: 'LINK-EUR', barCount: 1000 }] });
    expect(network).toHaveBeenCalledTimes(7); expect(await unrelated()).toEqual([]);
  });
});

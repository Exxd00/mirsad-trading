import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { closeDatabase, query, transaction, type SqlExecutor } from '../src/lib/db';
import { CONFIG } from '../src/lib/execution/v1/model';
import { createSqlGnosisEurStateStore } from '../src/lib/wallet/gnosis-eur-state-store';
import { GNOSIS_MARKET_PROVIDER, GNOSIS_REFERENCE_IDENTITY, gnosisEurSeriesDigest, type GnosisEurStateSeries } from '../src/lib/wallet/gnosis-market';
import { NOW } from './execution-fixtures';

// Synthetic semantic source records test SQL persistence only. They are not
// actual chain observations, a source certificate or executable prices.
const CLOSE = Math.floor(NOW / 900) * 900, hex = '0x' + '11'.repeat(32);
const store = () => createSqlGnosisEurStateStore({ clock: () => NOW });
function sample(first = CLOSE - 1800, count = 3, price = '100', interval: 60 | 900 = 900): GnosisEurStateSeries {
  const bars = Array.from({ length: count }, (_, i) => ({ source: CONFIG.candleSource, symbol: 'WETH-EUR',
    openTime: first + i * interval - interval, closeTime: first + i * interval,
    open: price, high: price, low: price, close: price, volume: '0', complete: true }));
  const marks = bars.map(b => ({ at: b.closeTime, wethEur: price, usdceEur: '0.9', xdaiEur: '0.91',
    eurUsdRoundId: '1', usdcUsdRoundId: '1', eurUsdUpdatedAt: b.closeTime - 10, usdcUsdUpdatedAt: b.closeTime - 10 }));
  const coverage: GnosisEurStateSeries['coverage'] = { identity: GNOSIS_REFERENCE_IDENTITY, state: hex, stable: hex, oracle: hex,
    bridgeReference: 'explicit-transmuter-underlying-reference-not-spot-peg', composition: 'chronological-block-and-global-log-index', finalized: true };
  return { version: 1, method: GNOSIS_MARKET_PROVIDER, chainId: 100, referenceOnly: true, executionReady: false,
    intervalSeconds: interval, bars, marks, coverage, provenanceId: gnosisEurSeriesDigest({ bars, marks, coverage }) };
}
beforeEach(async () => { await closeDatabase(); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('VERCEL', '');
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); });
afterEach(async () => { await closeDatabase(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('keeps complete original chunks through another adapter and native JSONB key ordering', async () => {
  const input = sample(); await store().save(input); await store().save(input);
  input.bars[0].close = '999';
  const loaded = await store().load({ intervalSeconds: 900, startExclusive: CLOSE - 2700, endInclusive: CLOSE });
  expect(loaded).toEqual([sample()]);
  expect((await query("SELECT key FROM app_settings WHERE key LIKE 'wallet:gnosis:eur-state:%:chunk:%'")).rows).toHaveLength(1);
  expect(await store().load({ intervalSeconds: 60, startExclusive: CLOSE - 180, endInclusive: CLOSE })).toEqual([]);
});

it('accepts semantic overlaps with different chunk proof ranges without replacing first observations', async () => {
  await store().save(sample());
  const overlap = sample(CLOSE - 900, 2); overlap.coverage.state = '0x' + '22'.repeat(32);
  overlap.provenanceId = gnosisEurSeriesDigest(overlap);
  await store().save(overlap);
  const loaded = await store().load({ intervalSeconds: 900, startExclusive: CLOSE - 1800, endInclusive: CLOSE });
  expect(loaded).toHaveLength(2); expect(loaded[0]).toEqual(sample()); expect(loaded[1]).toEqual(overlap);
});

it('commits a permanent source fence for a revised overlapping bar under a different chunk boundary', async () => {
  await store().save(sample());
  await expect(store().save(sample(CLOSE - 900, 2, '101'))).rejects.toThrow('gnosis_market_cache_conflict');
  await expect(store().load({ intervalSeconds: 900, startExclusive: CLOSE - 2700, endInclusive: CLOSE })).rejects.toThrow('gnosis_market_cache_conflict');
  await expect(store().save(sample(CLOSE - 2700, 1))).rejects.toThrow('gnosis_market_cache_conflict');
  const row = await query<{ value: { series: GnosisEurStateSeries } }>("SELECT value FROM app_settings WHERE key LIKE 'wallet:gnosis:eur-state:%:chunk:%'");
  expect(row.rows).toHaveLength(1); expect(row.rows[0].value.series).toEqual(sample());
});

it('serializes a conflicting first-writer race and preserves the winner', async () => {
  const outcomes = await Promise.allSettled([store().save(sample()), store().save(sample(CLOSE - 1800, 3, '101'))]);
  expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter(o => o.status === 'rejected')).toHaveLength(1);
  const row = await query<{ value: { series: GnosisEurStateSeries } }>("SELECT value FROM app_settings WHERE key LIKE 'wallet:gnosis:eur-state:%:chunk:%'");
  expect(row.rows).toHaveLength(1); expect(row.rows[0].value.series.bars[0].close).toBe(outcomes[0].status === 'fulfilled' ? '100' : '101');
  await expect(store().load({ intervalSeconds: 60, startExclusive: CLOSE - 60, endInclusive: CLOSE })).rejects.toThrow('gnosis_market_cache_conflict');
});

it('rejects future, excessive, corrupt-digest and foreign-method records before storing source data', async () => {
  const future = sample(CLOSE + 900, 1), excessive = sample(CLOSE - 201 * 900, 201), corrupt = sample(); corrupt.bars[0].close = '99';
  for (const value of [future, excessive, corrupt, { ...sample(), chainId: 1 }])
    await expect(store().save(value as GnosisEurStateSeries)).rejects.toThrow('gnosis_market_cache_invalid');
  await expect(store().load({ intervalSeconds: 900, startExclusive: CLOSE - 900, endInclusive: CLOSE + 900 })).rejects.toThrow('gnosis_market_cache_invalid');
  expect((await query("SELECT key FROM app_settings WHERE key LIKE 'wallet:gnosis:eur-state:%'")).rows).toEqual([]);
});

it('fails closed when SQL data no longer matches its immutable bar fingerprints', async () => {
  await store().save(sample());
  await query("UPDATE app_settings SET value=jsonb_set(value,'{fingerprint}',to_jsonb($1::text)) WHERE key LIKE 'wallet:gnosis:eur-state:%:bar:%'", ['0x' + '33'.repeat(32)]);
  await expect(store().load({ intervalSeconds: 900, startExclusive: CLOSE - 2700, endInclusive: CLOSE })).rejects.toThrow('gnosis_market_cache_invalid');
});

it('sanitizes driver failure details and has no memory fallback', async () => {
  const broken = createSqlGnosisEurStateStore({ transact: (async () => { throw new Error('private database URL'); }) as typeof transaction, clock: () => NOW });
  await expect(broken.save(sample())).rejects.toThrow('gnosis_market_cache_unavailable');
  await expect(broken.load({ intervalSeconds: 900, startExclusive: CLOSE - 2700, endInclusive: CLOSE })).rejects.toThrow('gnosis_market_cache_unavailable');
});

it('bounds SQL-returned payload before the driver materializes an oversized set of cached rows', async () => {
  await store().save(sample());
  const prefix = `wallet:gnosis:eur-state:v1:${GNOSIS_REFERENCE_IDENTITY}:chunk:900:`;
  const rows = Array.from({ length: 17 }, (_, i) => ({ key: prefix + String(CLOSE - (i + 10) * 900).padStart(16, '0') + ':' + String(CLOSE).padStart(16, '0'),
    value: { padding: 'x'.repeat(1_100_000) } }));
  await query('INSERT INTO app_settings(key,value) SELECT v.key,v.value FROM jsonb_to_recordset($1::jsonb) AS v(key text,value jsonb)', [JSON.stringify(rows)]);
  let returnedBytes = 0, nulls = 0;
  const monitored: typeof transaction = work => transaction(tx => work({
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await tx.query<T>(sql, params);
      if (sql.startsWith('WITH candidates')) for (const raw of result.rows) {
        const v = (raw as { value: unknown }).value;
        if (v === null) nulls++; else returnedBytes += Buffer.byteLength(JSON.stringify(v));
      }
      return result;
    },
  } satisfies SqlExecutor));
  const bounded = createSqlGnosisEurStateStore({ transact: monitored, clock: () => NOW });
  await expect(bounded.load({ intervalSeconds: 900, startExclusive: CLOSE - 1000 * 900, endInclusive: CLOSE })).rejects.toThrow('gnosis_market_cache_invalid');
  expect(nulls).toBeGreaterThan(0);
  expect(returnedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
});

it('retains complete source chunks and their quarantine across a disk database restart', async () => {
  const location = await mkdtemp(join(tmpdir(), 'mirsad-eur-state-')); vi.stubEnv('LOCAL_DATABASE_PATH', location);
  try {
    await store().save(sample()); await closeDatabase();
    expect(await store().load({ intervalSeconds: 900, startExclusive: CLOSE - 2700, endInclusive: CLOSE })).toEqual([sample()]);
    await expect(store().save(sample(CLOSE - 900, 1, '102'))).rejects.toThrow('gnosis_market_cache_conflict');
    await closeDatabase();
    await expect(store().load({ intervalSeconds: 900, startExclusive: CLOSE - 2700, endInclusive: CLOSE })).rejects.toThrow('gnosis_market_cache_conflict');
  } finally {
    await closeDatabase(); const actual = await realpath(location), parent = await realpath(tmpdir());
    if (resolve(actual) !== resolve(location) || resolve(dirname(actual)) !== resolve(parent) || !basename(actual).startsWith('mirsad-eur-state-')) throw new Error('test_cleanup_scope_invalid');
    await rm(actual, { recursive: true, force: true });
  }
});

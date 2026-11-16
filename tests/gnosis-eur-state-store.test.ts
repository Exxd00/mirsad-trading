import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { closeDatabase, query, transaction, type SqlExecutor } from '../src/lib/db';
import { CONFIG } from '../src/lib/execution/v1/model';
import { createSqlGnosisEurStateStore } from '../src/lib/wallet/gnosis-eur-state-store';
import { GNOSIS_MARKET_PROVIDER, GNOSIS_REFERENCE_IDENTITY,GNOSIS_EMA_CACHE_PREFIX,GNOSIS_LEGACY_CACHE_PREFIX,gnosisHistoryPolicyEvidence,
  gnosisLegacyBarFingerprint,parseLegacyGnosisEurSeries, gnosisEurSeriesDigest, type GnosisEurStateSeries } from '../src/lib/wallet/gnosis-market';
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
    bridgeReference: 'explicit-transmuter-underlying-reference-not-spot-peg', composition: 'chronological-block-and-global-log-index', finalized: true,
    ...(interval===900?{historyPolicy:gnosisHistoryPolicyEvidence()}:{}) };
  return { version: 1, method: GNOSIS_MARKET_PROVIDER, chainId: 100, referenceOnly: true, executionReady: false,
    intervalSeconds: interval, bars, marks, coverage, provenanceId: gnosisEurSeriesDigest({ bars, marks, coverage }) };
}
beforeEach(async () => { await closeDatabase(); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('VERCEL', '');
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); });
afterEach(async () => { await closeDatabase(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function seedLegacy(inputs=[sample()]){
  const rows:{key:string;value:unknown}[]=[{key:GNOSIS_LEGACY_CACHE_PREFIX+'quarantine',value:{version:1,quarantined:false}}];
  for(const s of inputs){delete s.coverage.historyPolicy;s.provenanceId=gnosisEurSeriesDigest(s);parseLegacyGnosisEurSeries(s);
    const stamp=(n:number)=>String(n).padStart(16,'0'),first=s.bars[0].closeTime,last=s.bars.at(-1)!.closeTime;
    rows.push({key:GNOSIS_LEGACY_CACHE_PREFIX+`chunk:900:${stamp(first)}:${stamp(last)}`,value:{version:1,firstClose:first,lastClose:last,series:s}},
      ...s.bars.map((b,i)=>({key:GNOSIS_LEGACY_CACHE_PREFIX+`bar:900:${stamp(b.closeTime)}`,
        value:{version:1,intervalSeconds:900,closeTime:b.closeTime,fingerprint:gnosisLegacyBarFingerprint(b,s.marks[i])}})));}
  await query(`INSERT INTO app_settings(key,value) SELECT v.key,v.value FROM jsonb_to_recordset($1::jsonb) AS v(key text,value jsonb)`,[JSON.stringify(rows)]);
  return inputs[0];
}
it('imports actual immutable v1 SQL evidence atomically and retains its bytes, fingerprints and parent lineage',async()=>{
  const old=await seedLegacy(),before=await query('SELECT key,value FROM app_settings ORDER BY key');
  const imported=await store().load({intervalSeconds:900,startExclusive:CLOSE-2700,endInclusive:CLOSE});
  expect(imported).toHaveLength(1);expect(imported[0].bars).toEqual(old.bars);expect(imported[0].marks).toEqual(old.marks);
  expect(imported[0].coverage.historyPolicy?.lineage).toEqual({provenanceId:old.provenanceId,
    barFingerprints:old.bars.map((b,i)=>gnosisLegacyBarFingerprint(b,old.marks[i]))});
  expect((await query('SELECT key,value FROM app_settings WHERE key LIKE $1 ORDER BY key',[GNOSIS_LEGACY_CACHE_PREFIX+'%'])).rows).toEqual(before.rows);
  const restarted=await store().load({intervalSeconds:900,startExclusive:CLOSE-2700,endInclusive:CLOSE});
  expect(restarted.every(s=>s.bars.every((b,i)=>b.close===old.bars[i].close))).toBe(true);
  await query('UPDATE app_settings SET value=$2::jsonb WHERE key=$1',[GNOSIS_LEGACY_CACHE_PREFIX+'quarantine',JSON.stringify({version:1,quarantined:true})]);
  await expect(store().load({intervalSeconds:900,startExclusive:CLOSE-2700,endInclusive:CLOSE})).rejects.toThrow('gnosis_market_cache_conflict');
});
it('refuses a missing original fingerprint without creating trusted v2 lineage',async()=>{
  await seedLegacy();await query('DELETE FROM app_settings WHERE key LIKE $1',[GNOSIS_LEGACY_CACHE_PREFIX+'bar:%']);
  await expect(store().load({intervalSeconds:900,startExclusive:CLOSE-2700,endInclusive:CLOSE})).rejects.toThrow('gnosis_market_cache_invalid');
  expect((await query('SELECT key FROM app_settings WHERE key LIKE $1',[GNOSIS_EMA_CACHE_PREFIX+'chunk:%'])).rows).toEqual([]);
});
it('does not manufacture a clean parent quarantine row for legacy capsules lacking their original fence',async()=>{
  await seedLegacy();await query('DELETE FROM app_settings WHERE key=$1',[GNOSIS_LEGACY_CACHE_PREFIX+'quarantine']);
  await expect(store().load({intervalSeconds:900,startExclusive:CLOSE-2700,endInclusive:CLOSE})).rejects.toThrow('gnosis_market_cache_invalid');
  expect((await query('SELECT key FROM app_settings WHERE key LIKE $1',[GNOSIS_EMA_CACHE_PREFIX+'chunk:%'])).rows).toEqual([]);
  expect((await query('SELECT key FROM app_settings WHERE key=$1',[GNOSIS_LEGACY_CACHE_PREFIX+'quarantine'])).rows).toEqual([]);
});
it.each([true,false])('does not let an independent v2 capsule hide a conflicting v1 parent (same range=%s)',async sameRange=>{
  await seedLegacy();await store().save(sample(sameRange?CLOSE-1800:CLOSE-900,sameRange?3:2,'101'));
  await expect(store().load({intervalSeconds:900,startExclusive:CLOSE-2700,endInclusive:CLOSE})).rejects.toThrow('gnosis_market_cache_conflict');
  expect((await query<{value:{quarantined:boolean}}>('SELECT value FROM app_settings WHERE key=$1',[GNOSIS_EMA_CACHE_PREFIX+'quarantine'])).rows[0].value.quarantined).toBe(true);
});
it('imports 1000 single-bar parents without doubling the logical cold-load chunk budget',async()=>{
  await seedLegacy(Array.from({length:1000},(_,i)=>sample(CLOSE-(999-i)*900,1)));
  const range={intervalSeconds:900 as const,startExclusive:CLOSE-900000,endInclusive:CLOSE};
  expect(await store().load(range)).toHaveLength(1000);
  expect(await store().load(range)).toHaveLength(1000);
},20000);
it('keeps strict minute evidence usable when only the new EMA policy namespace is quarantined',async()=>{
  const minute=sample(CLOSE-120,3,'100',60);await store().save(minute);await store().save(sample());
  await expect(store().save(sample(CLOSE-1800,3,'101'))).rejects.toThrow('gnosis_market_cache_conflict');
  expect(await store().load({intervalSeconds:60,startExclusive:CLOSE-180,endInclusive:CLOSE})).toEqual([minute]);
});
it('roundtrips qualified bars through native JSONB and distinguishes intrinsic event proof from chunk context',async()=>{
  const s=sample(CLOSE,1),open=s.bars[0].openTime,h=('0x'+'33'.repeat(32)) as `0x${string}`;
  s.coverage.historyPolicy!.qualifications=[{feed:'usdcUsd',at:open+50,barOpenTime:open,barCloseTime:CLOSE,roundId:'1',answerRaw:'100000000',updatedAt:open+50-86405,
    event:{kind:'pool',logIndex:1,block:{number:'1001',hash:h,timestamp:open+50}},
    successor:{roundId:'2',updatedAt:open+55,transactionHash:h,logIndex:97,block:{number:'1002',hash:h,timestamp:open+55}}}];
  s.marks[0].usdcUsdRoundId='3';s.provenanceId=gnosisEurSeriesDigest(s);await store().save(s);
  expect(await store().load({intervalSeconds:900,startExclusive:CLOSE-900,endInclusive:CLOSE})).toEqual([s]);
  const anotherContext=structuredClone(s);anotherContext.coverage.state='0x'+'44'.repeat(32);
  anotherContext.coverage.historyPolicy!.parents=[h];anotherContext.provenanceId=gnosisEurSeriesDigest(anotherContext);
  await store().save(anotherContext); // Same intrinsic price/event evidence, another proof window.
  const changed=structuredClone(s);changed.coverage.historyPolicy!.qualifications[0].event.logIndex=2;changed.provenanceId=gnosisEurSeriesDigest(changed);
  await expect(store().save(changed)).rejects.toThrow('gnosis_market_cache_conflict');
});

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
  // A v2 EMA-policy quarantine does not reinterpret strict minute evidence.
  expect(await store().load({ intervalSeconds: 60, startExclusive: CLOSE - 60, endInclusive: CLOSE })).toEqual([]);
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
  const prefix = GNOSIS_EMA_CACHE_PREFIX+'chunk:900:';
  const rows = Array.from({ length: 17 }, (_, i) => ({ key: prefix + String(CLOSE - (i + 10) * 900).padStart(16, '0') + ':' + String(CLOSE).padStart(16, '0'),
    value: { padding: 'x'.repeat(1_100_000) } }));
  await query('INSERT INTO app_settings(key,value) SELECT v.key,v.value FROM jsonb_to_recordset($1::jsonb) AS v(key text,value jsonb)', [JSON.stringify(rows)]);
  let returnedBytes = 0, nulls = 0;
  const monitored: typeof transaction = work => transaction(tx => work({
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await tx.query<T>(sql, params);
      if (sql.startsWith('WITH ')&&sql.includes('cumulative_bytes')) for (const raw of result.rows) {
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

import 'server-only';
import { transaction, type SqlExecutor } from '../db';
import { GNOSIS_REFERENCE_IDENTITY, gnosisEurBarFingerprint, parseStoredGnosisEurSeries,
  type GnosisEurStateSeries, type GnosisEurStateStore } from './gnosis-market';

const PREFIX = `wallet:gnosis:eur-state:v1:${GNOSIS_REFERENCE_IDENTITY}:`;
const FENCE = PREFIX + 'quarantine';
const MAX_BYTES = 2 * 1024 * 1024, MAX_LOADED_BYTES = 16 * 1024 * 1024, MAX_CHUNKS = 1200;
type Code = 'gnosis_market_cache_invalid' | 'gnosis_market_cache_conflict' | 'gnosis_market_cache_unavailable';
export class GnosisEurStoreError extends Error { constructor(readonly code: Code) { super(code); this.name = 'GnosisEurStoreError'; } }
const fail = (code: Code): never => { throw new GnosisEurStoreError(code); };
const stamp = (n: number) => String(n).padStart(16, '0');
const chunkPrefix = (step: number) => PREFIX + `chunk:${step}:`;
const barKey = (step: number, close: number) => PREFIX + `bar:${step}:${stamp(close)}`;
const exact = (v: object, keys: string[]) => Reflect.ownKeys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
type Capsule = { version: 1; firstClose: number; lastClose: number; series: GnosisEurStateSeries };
function series(raw: unknown, now: number): GnosisEurStateSeries {
  try {
    const s = parseStoredGnosisEurSeries(raw);
    if (!s.bars.length || s.bars.length > 200 || s.bars.at(-1)!.closeTime > Math.floor(now / s.intervalSeconds) * s.intervalSeconds
      || Buffer.byteLength(JSON.stringify(s)) > MAX_BYTES) return fail('gnosis_market_cache_invalid');
    return structuredClone(s);
  } catch { return fail('gnosis_market_cache_invalid'); }
}
function capsule(raw: unknown, now: number): Capsule {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !exact(raw, ['version', 'firstClose', 'lastClose', 'series'])) return fail('gnosis_market_cache_invalid');
  const v = raw as Capsule, s = series(v.series, now);
  if (v.version !== 1 || v.firstClose !== s.bars[0].closeTime || v.lastClose !== s.bars.at(-1)!.closeTime) return fail('gnosis_market_cache_invalid');
  return { version: 1, firstClose: v.firstClose, lastClose: v.lastClose, series: s };
}
const chunkKey = (v: Capsule) => chunkPrefix(v.series.intervalSeconds) + stamp(v.firstClose) + ':' + stamp(v.lastClose);
const barValue = (step: number, close: number, fingerprint: string) => ({ version: 1, intervalSeconds: step, closeTime: close, fingerprint });
function checkedBar(raw: unknown, step: number, close: number): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !exact(raw, ['version', 'intervalSeconds', 'closeTime', 'fingerprint'])) return fail('gnosis_market_cache_invalid');
  const v = raw as ReturnType<typeof barValue>;
  if (v.version !== 1 || v.intervalSeconds !== step || v.closeTime !== close || typeof v.fingerprint !== 'string'
    || !/^0x[0-9a-f]{64}$/.test(v.fingerprint)) return fail('gnosis_market_cache_invalid');
  return v.fingerprint;
}
async function fence(tx: SqlExecutor, lock: 'SHARE' | 'UPDATE'): Promise<boolean> {
  const r = await tx.query<{ value: unknown }>(`SELECT value FROM app_settings WHERE key=$1 FOR ${lock}`, [FENCE]);
  if (r.rows.length > 1) return fail('gnosis_market_cache_invalid');
  if (!r.rows.length) return false;
  const v = r.rows[0].value;
  if (!v || typeof v !== 'object' || Array.isArray(v) || !exact(v, ['version', 'quarantined'])
    || (v as { version?: unknown }).version !== 1 || typeof (v as { quarantined?: unknown }).quarantined !== 'boolean') return fail('gnosis_market_cache_invalid');
  return (v as { quarantined: boolean }).quarantined;
}

/** Immutable, private market evidence in the existing indexed app_settings.
 * One short per-source transaction serializes overlap checks and quarantines a
 * revision before reporting it. Source/network work is outside the transaction.
 * No authority, inventory, performance or schema/grant mutation belongs here. */
export function createSqlGnosisEurStateStore(options: { transact?: typeof transaction; clock?: () => number } = {}): GnosisEurStateStore {
  const transact = options.transact ?? transaction, clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
  const safe = async <T>(work: () => Promise<T>) => { try { return await work(); } catch (e) {
    if (e instanceof GnosisEurStoreError) throw e; return fail('gnosis_market_cache_unavailable'); } };
  return {
    load: input => safe(async () => {
      const now = clock();
      if (!input || !exact(input, ['intervalSeconds', 'startExclusive', 'endInclusive']) || ![60, 900].includes(input.intervalSeconds)
        || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(input.startExclusive) || input.startExclusive < 0
        || !Number.isSafeInteger(input.endInclusive) || input.endInclusive < input.startExclusive
        || input.startExclusive % input.intervalSeconds || input.endInclusive % input.intervalSeconds
        || input.endInclusive > Math.floor(now / input.intervalSeconds) * input.intervalSeconds
        || input.endInclusive - input.startExclusive > 1000 * input.intervalSeconds) return fail('gnosis_market_cache_invalid');
      return transact(async tx => {
        if (await fence(tx, 'SHARE')) return fail('gnosis_market_cache_conflict');
        if (input.startExclusive === input.endInclusive) return [];
        const prefix = chunkPrefix(input.intervalSeconds);
        const result = await tx.query<{ key: string; value: unknown }>(`WITH candidates AS (
          SELECT key,value,octet_length(value::text) AS bytes FROM app_settings
          WHERE key>=$1 AND key<$2 ORDER BY key LIMIT 1201
        ), sized AS (
          SELECT key,value,bytes,SUM(bytes) OVER(ORDER BY key) AS cumulative_bytes FROM candidates
        ) SELECT key,CASE WHEN bytes<=$3 AND cumulative_bytes<=$4 THEN value ELSE NULL END AS value
          FROM sized ORDER BY key`,
        [prefix + stamp(Math.max(0, input.startExclusive - 200 * input.intervalSeconds)), prefix + stamp(input.endInclusive + 1), MAX_BYTES, MAX_LOADED_BYTES]);
        if (result.rows.length > MAX_CHUNKS) return fail('gnosis_market_cache_invalid');
        let bytes = 0; const relevant: Capsule[] = [], expected = new Map<string, { step: number; close: number; fingerprint: string }>();
        for (const row of result.rows) {
          bytes += Buffer.byteLength(JSON.stringify(row.value)); if (bytes > MAX_LOADED_BYTES) return fail('gnosis_market_cache_invalid');
          const c = capsule(row.value, now);
          if (row.key !== chunkKey(c) || c.series.intervalSeconds !== input.intervalSeconds) return fail('gnosis_market_cache_invalid');
          if (c.lastClose <= input.startExclusive || c.firstClose > input.endInclusive) continue;
          relevant.push(c);
          c.series.bars.forEach((bar, i) => {
            const key = barKey(c.series.intervalSeconds, bar.closeTime), fingerprint = gnosisEurBarFingerprint(bar, c.series.marks[i]);
            const prior = expected.get(key); if (prior && prior.fingerprint !== fingerprint) return fail('gnosis_market_cache_invalid');
            expected.set(key, { step: c.series.intervalSeconds, close: bar.closeTime, fingerprint });
          });
        }
        if (expected.size > 1400) return fail('gnosis_market_cache_invalid');
        if (expected.size) {
          const rows = await tx.query<{ key: string; value: unknown }>('SELECT key,value FROM app_settings WHERE key=ANY($1::text[])', [[...expected.keys()]]);
          if (rows.rows.length !== expected.size) return fail('gnosis_market_cache_invalid');
          for (const row of rows.rows) { const e = expected.get(row.key);
            if (!e || checkedBar(row.value, e.step, e.close) !== e.fingerprint) return fail('gnosis_market_cache_invalid'); }
        }
        if (await fence(tx, 'SHARE')) return fail('gnosis_market_cache_conflict');
        return relevant.map(c => c.series);
      });
    }),
    save: input => safe(async () => {
      const now = clock(); if (!Number.isSafeInteger(now) || now < 0) return fail('gnosis_market_cache_invalid');
      const s = series(input, now), c: Capsule = { version: 1, firstClose: s.bars[0].closeTime, lastClose: s.bars.at(-1)!.closeTime, series: s };
      const desired = s.bars.map((bar, i) => ({ key: barKey(s.intervalSeconds, bar.closeTime),
        value: barValue(s.intervalSeconds, bar.closeTime, gnosisEurBarFingerprint(bar, s.marks[i])) }));
      const okay = await transact(async tx => {
        await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO NOTHING', [FENCE, JSON.stringify({ version: 1, quarantined: false })]);
        if (await fence(tx, 'UPDATE')) return false;
        const rows = await tx.query<{ key: string; value: unknown }>('SELECT key,value FROM app_settings WHERE key=ANY($1::text[])', [desired.map(x => x.key)]);
        const incoming = new Map(desired.map(x => [x.key, x.value])); let conflict = false;
        for (const row of rows.rows) { const proposed = incoming.get(row.key); if (!proposed) return fail('gnosis_market_cache_invalid');
          if (checkedBar(row.value, proposed.intervalSeconds, proposed.closeTime) !== proposed.fingerprint) conflict = true; }
        if (conflict) {
          await tx.query('UPDATE app_settings SET value=$2::jsonb,updated_at=NOW() WHERE key=$1', [FENCE, JSON.stringify({ version: 1, quarantined: true })]);
          return false; // Commit the fence before throwing outside this transaction.
        }
        const existing = await tx.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [chunkKey(c)]);
        if (existing.rows.length > 1) return fail('gnosis_market_cache_invalid');
        if (existing.rows.length) capsule(existing.rows[0].value, now);
        await tx.query(`INSERT INTO app_settings(key,value)
          SELECT v.key,v.value FROM jsonb_to_recordset($1::jsonb) AS v(key text,value jsonb) ORDER BY v.key
          ON CONFLICT(key) DO NOTHING`, [JSON.stringify(desired)]);
        await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO NOTHING', [chunkKey(c), JSON.stringify(c)]);
        return true;
      });
      if (!okay) return fail('gnosis_market_cache_conflict');
    }),
  };
}
export const sqlGnosisEurStateStore = createSqlGnosisEurStateStore();

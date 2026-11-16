import 'server-only';
import { transaction, type SqlExecutor } from '../db';
import { GNOSIS_EMA_CACHE_PREFIX, GNOSIS_LEGACY_CACHE_PREFIX, gnosisEurBarFingerprint, gnosisLegacyBarFingerprint,
  parseLegacyGnosisEurSeries, qualifyLegacyGnosisEurSeries, parseStoredGnosisEurSeries,
  type GnosisEurStateSeries, type GnosisEurStateStore } from './gnosis-market';

const PREFIX = GNOSIS_EMA_CACHE_PREFIX;
const FENCE = PREFIX + 'quarantine';
const MAX_BYTES = 2 * 1024 * 1024, MAX_LOADED_BYTES = 16 * 1024 * 1024, MAX_CHUNKS = 1200;
type Code = 'gnosis_market_cache_invalid' | 'gnosis_market_cache_conflict' | 'gnosis_market_cache_unavailable';
export class GnosisEurStoreError extends Error { constructor(readonly code: Code) { super(code); this.name = 'GnosisEurStoreError'; } }
const fail = (code: Code): never => { throw new GnosisEurStoreError(code); };
const stamp = (n: number) => String(n).padStart(16, '0');
const namespace=(step:number,legacy=false)=>legacy||step===60?GNOSIS_LEGACY_CACHE_PREFIX:PREFIX;
const chunkPrefix = (step: number,legacy=false) => namespace(step,legacy) + `chunk:${step}:`;
const barKey = (step: number, close: number,legacy=false) => namespace(step,legacy) + `bar:${step}:${stamp(close)}`;
const exact = (v: object, keys: string[]) => Reflect.ownKeys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
type Capsule = { version: 1; firstClose: number; lastClose: number; series: GnosisEurStateSeries };
function series(raw: unknown, now: number,legacy=false): GnosisEurStateSeries {
  try {
    const s = legacy?parseLegacyGnosisEurSeries(raw):parseStoredGnosisEurSeries(raw);
    if (!s.bars.length || s.bars.length > 200 || s.bars.at(-1)!.closeTime > Math.floor(now / s.intervalSeconds) * s.intervalSeconds
      || Buffer.byteLength(JSON.stringify(s)) > MAX_BYTES) return fail('gnosis_market_cache_invalid');
    return structuredClone(s);
  } catch { return fail('gnosis_market_cache_invalid'); }
}
function capsule(raw: unknown, now: number,legacy=false): Capsule {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !exact(raw, ['version', 'firstClose', 'lastClose', 'series'])) return fail('gnosis_market_cache_invalid');
  const v = raw as Capsule, s = series(v.series, now,legacy);
  if (v.version !== 1 || v.firstClose !== s.bars[0].closeTime || v.lastClose !== s.bars.at(-1)!.closeTime) return fail('gnosis_market_cache_invalid');
  return { version: 1, firstClose: v.firstClose, lastClose: v.lastClose, series: s };
}
const chunkKey = (v: Capsule,legacy=false) => chunkPrefix(v.series.intervalSeconds,legacy) + stamp(v.firstClose) + ':' + stamp(v.lastClose);
const barValue = (step: number, close: number, fingerprint: string) => ({ version: 1, intervalSeconds: step, closeTime: close, fingerprint });
function checkedBar(raw: unknown, step: number, close: number): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !exact(raw, ['version', 'intervalSeconds', 'closeTime', 'fingerprint'])) return fail('gnosis_market_cache_invalid');
  const v = raw as ReturnType<typeof barValue>;
  if (v.version !== 1 || v.intervalSeconds !== step || v.closeTime !== close || typeof v.fingerprint !== 'string'
    || !/^0x[0-9a-f]{64}$/.test(v.fingerprint)) return fail('gnosis_market_cache_invalid');
  return v.fingerprint;
}
async function fence(tx: SqlExecutor, lock: 'SHARE' | 'UPDATE',key=FENCE,required=false): Promise<boolean> {
  const r = await tx.query<{ value: unknown }>(`SELECT value FROM app_settings WHERE key=$1 FOR ${lock}`, [key]);
  if (r.rows.length > 1) return fail('gnosis_market_cache_invalid');
  if (!r.rows.length) return required?fail('gnosis_market_cache_invalid'):false;
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
        // Parent quarantine remains authoritative after import. The parent
        // SHARE lock and child UPDATE lock span verification AND lineage save.
        if(await fence(tx,'SHARE',GNOSIS_LEGACY_CACHE_PREFIX+'quarantine'))return fail('gnosis_market_cache_conflict');
        if(input.intervalSeconds===900){
          await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO NOTHING',[FENCE,JSON.stringify({version:1,quarantined:false})]);
          if(await fence(tx,'UPDATE'))return fail('gnosis_market_cache_conflict');
        }
        if (input.startExclusive === input.endInclusive) return [];
        const prefix = chunkPrefix(input.intervalSeconds),parent=chunkPrefix(input.intervalSeconds,true);
        const result = await tx.query<{ key: string; value: unknown;bytes:number }>(`WITH selected AS (
          SELECT DISTINCT ON(RIGHT(key,33)) key,value FROM app_settings
          WHERE (key>=$1 AND key<$2) OR (key>=$5 AND key<$6) ORDER BY RIGHT(key,33),key DESC
        ), candidates AS (
          SELECT key,value,octet_length(value::text) AS bytes FROM app_settings
          WHERE key IN(SELECT key FROM selected) ORDER BY key LIMIT 1201
        ), sized AS (
          SELECT key,value,bytes,SUM(bytes) OVER(ORDER BY key) AS cumulative_bytes FROM candidates
        ) SELECT key,bytes,CASE WHEN bytes<=$3 AND cumulative_bytes<=$4 THEN value ELSE NULL END AS value
          FROM sized ORDER BY key`,
        [prefix + stamp(Math.max(0, input.startExclusive - 200 * input.intervalSeconds)), prefix + stamp(input.endInclusive + 1), MAX_BYTES, MAX_LOADED_BYTES,
          parent+stamp(Math.max(0,input.startExclusive-200*input.intervalSeconds)),parent+stamp(input.endInclusive+1)]);
        if (result.rows.length > MAX_CHUNKS) return fail('gnosis_market_cache_invalid');
        let bytes = 0; const relevant: {capsule:Capsule;legacy:boolean}[] = [], expected = new Map<string, { step: number; close: number; fingerprint: string }>();
        for (const row of result.rows) {
          if(!Number.isSafeInteger(row.bytes)||row.bytes<1)return fail('gnosis_market_cache_invalid');
          bytes += row.bytes; if (bytes > MAX_LOADED_BYTES) return fail('gnosis_market_cache_invalid');
          const legacy=row.key.startsWith(GNOSIS_LEGACY_CACHE_PREFIX),c = capsule(row.value, now,legacy);
          if (row.key !== chunkKey(c,legacy) || c.series.intervalSeconds !== input.intervalSeconds) return fail('gnosis_market_cache_invalid');
          if (c.lastClose <= input.startExclusive || c.firstClose > input.endInclusive) continue;
          relevant.push({capsule:c,legacy});
          c.series.bars.forEach((bar, i) => {
            const key = barKey(c.series.intervalSeconds, bar.closeTime,legacy), fingerprint = legacy?gnosisLegacyBarFingerprint(bar,c.series.marks[i]):gnosisEurBarFingerprint(bar, c.series.marks[i],c.series.coverage.historyPolicy);
            const prior = expected.get(key); if (prior && prior.fingerprint !== fingerprint) return fail('gnosis_market_cache_invalid');
            expected.set(key, { step: c.series.intervalSeconds, close: bar.closeTime, fingerprint });
          });
        }
        // A child replaces only the scan slot of the identical parent range.
        // Required parents are still read and fingerprint-checked under the
        // same lock and SAME total byte ceiling, without doubling chunk count.
        const parentCapsules=relevant.filter(r=>r.legacy).map(r=>r.capsule);
        const parentKeys=[...new Set(relevant.filter(r=>!r.legacy).map(r=>chunkKey(r.capsule,true)))];
        const requiredParents=new Set(relevant.filter(r=>!r.legacy&&r.capsule.series.coverage.historyPolicy?.lineage).map(r=>chunkKey(r.capsule,true)));
        if(parentKeys.length){
          const rows=await tx.query<{key:string;value:unknown;bytes:number}>(`WITH sized AS (
            SELECT key,value,octet_length(value::text) AS bytes,SUM(octet_length(value::text)) OVER(ORDER BY key) AS cumulative_bytes
            FROM app_settings WHERE key=ANY($1::text[]))
            SELECT key,bytes,CASE WHEN bytes<=$2 AND cumulative_bytes<=$3 THEN value ELSE NULL END AS value FROM sized ORDER BY key`,
            [parentKeys,MAX_BYTES,MAX_LOADED_BYTES-bytes]);
          for(const key of requiredParents)if(!rows.rows.some(r=>r.key===key))return fail('gnosis_market_cache_invalid');
          for(const row of rows.rows){if(!Number.isSafeInteger(row.bytes)||row.bytes<1)return fail('gnosis_market_cache_invalid');
            bytes+=row.bytes;if(bytes>MAX_LOADED_BYTES)return fail('gnosis_market_cache_invalid');
            const c=capsule(row.value,now,true);if(row.key!==chunkKey(c,true)||c.series.intervalSeconds!==900)return fail('gnosis_market_cache_invalid');parentCapsules.push(c);
            c.series.bars.forEach((b,i)=>{const key=barKey(900,b.closeTime,true),fingerprint=gnosisLegacyBarFingerprint(b,c.series.marks[i]),prior=expected.get(key);
              if(prior&&prior.fingerprint!==fingerprint)return fail('gnosis_market_cache_invalid');expected.set(key,{step:900,close:b.closeTime,fingerprint});});
          }
        }
        if(parentCapsules.length&&await fence(tx,'SHARE',GNOSIS_LEGACY_CACHE_PREFIX+'quarantine',true))return fail('gnosis_market_cache_conflict');
        if (expected.size > 2800) return fail('gnosis_market_cache_invalid');
        if (expected.size) {
          const rows = await tx.query<{ key: string; value: unknown }>('SELECT key,value FROM app_settings WHERE key=ANY($1::text[])', [[...expected.keys()]]);
          if (rows.rows.length !== expected.size) return fail('gnosis_market_cache_invalid');
          for (const row of rows.rows) { const e = expected.get(row.key);
            if (!e || checkedBar(row.value, e.step, e.close) !== e.fingerprint) return fail('gnosis_market_cache_invalid'); }
        }
        const parents=new Map(parentCapsules.map(c=>[c.series.provenanceId,c.series]));
        const byRange=new Map(parentCapsules.map(c=>[chunkKey(c,true),c.series]));
        for(const {capsule:c,legacy} of relevant){const p=!legacy&&byRange.get(chunkKey(c,true));if(p){
          if(p.bars.length!==c.series.bars.length||p.bars.some((b,i)=>gnosisEurBarFingerprint(b,p.marks[i])!==gnosisEurBarFingerprint(c.series.bars[i],c.series.marks[i],c.series.coverage.historyPolicy))){
            await tx.query('UPDATE app_settings SET value=$2::jsonb,updated_at=NOW() WHERE key=$1',[FENCE,JSON.stringify({version:1,quarantined:true})]);return null;
          }
        }}
        for(const {capsule:c,legacy} of relevant){const l=c.series.coverage.historyPolicy?.lineage;if(!legacy&&l){const p=parents.get(l.provenanceId);
          if(!p||p.bars.length!==c.series.bars.length||p.bars.some((b,i)=>gnosisLegacyBarFingerprint(b,p.marks[i])!==l.barFingerprints[i]))return fail('gnosis_market_cache_invalid');}}
        const imported=input.intervalSeconds===900?relevant.filter(r=>r.legacy).map(r=>qualifyLegacyGnosisEurSeries(r.capsule.series)):[];
        if(imported.length){
          const desired=new Map<string,{key:string;value:unknown}>();
          for(const s of imported){const c:Capsule={version:1,firstClose:s.bars[0].closeTime,lastClose:s.bars.at(-1)!.closeTime,series:s};
            series(s,now);desired.set(chunkKey(c),{key:chunkKey(c),value:c});
            s.bars.forEach((b,i)=>{const key=barKey(900,b.closeTime);desired.set(key,{key,value:barValue(900,b.closeTime,gnosisEurBarFingerprint(b,s.marks[i],s.coverage.historyPolicy))});});}
          const checks=[...desired.values()].filter(v=>v.key.includes(':bar:'));
          const existing=await tx.query<{key:string;value:unknown}>('SELECT key,value FROM app_settings WHERE key=ANY($1::text[])',[checks.map(v=>v.key)]);
          if(existing.rows.some(r=>{const v=desired.get(r.key)?.value as ReturnType<typeof barValue>|undefined;return !v||checkedBar(r.value,900,v.closeTime)!==v.fingerprint;})){
            await tx.query('UPDATE app_settings SET value=$2::jsonb,updated_at=NOW() WHERE key=$1',[FENCE,JSON.stringify({version:1,quarantined:true})]);
            return null; // Commit quarantine; never overwrite the parent or child.
          }
          await tx.query(`INSERT INTO app_settings(key,value) SELECT v.key,v.value FROM jsonb_to_recordset($1::jsonb) AS v(key text,value jsonb)
            ORDER BY v.key ON CONFLICT(key) DO NOTHING`,[JSON.stringify([...desired.values()])]);
        }
        const output=relevant.filter(r=>!r.legacy||input.intervalSeconds===60).map(r=>r.capsule.series).concat(imported);
        if(output.reduce((n,s)=>n+Buffer.byteLength(JSON.stringify(s)),0)>MAX_LOADED_BYTES)return fail('gnosis_market_cache_invalid');
        return output;
      }).then(result=>result??fail('gnosis_market_cache_conflict'));
    }),
    save: input => safe(async () => {
      const now = clock(); if (!Number.isSafeInteger(now) || now < 0) return fail('gnosis_market_cache_invalid');
      const s = series(input, now), c: Capsule = { version: 1, firstClose: s.bars[0].closeTime, lastClose: s.bars.at(-1)!.closeTime, series: s };
      // Only the atomic load/import path may certify original SQL lineage.
      if(s.coverage.historyPolicy?.lineage)return fail('gnosis_market_cache_invalid');
      const desired = s.bars.map((bar, i) => ({ key: barKey(s.intervalSeconds, bar.closeTime),
        value: barValue(s.intervalSeconds, bar.closeTime, gnosisEurBarFingerprint(bar, s.marks[i],s.coverage.historyPolicy)) }));
      const okay = await transact(async tx => {
        if(s.intervalSeconds===900&&await fence(tx,'SHARE',GNOSIS_LEGACY_CACHE_PREFIX+'quarantine'))return false;
        const fenceKey=namespace(s.intervalSeconds)+'quarantine';
        await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO NOTHING', [fenceKey, JSON.stringify({ version: 1, quarantined: false })]);
        if (await fence(tx, 'UPDATE',fenceKey)) return false;
        const rows = await tx.query<{ key: string; value: unknown }>('SELECT key,value FROM app_settings WHERE key=ANY($1::text[])', [desired.map(x => x.key)]);
        const incoming = new Map(desired.map(x => [x.key, x.value])); let conflict = false;
        for (const row of rows.rows) { const proposed = incoming.get(row.key); if (!proposed) return fail('gnosis_market_cache_invalid');
          if (checkedBar(row.value, proposed.intervalSeconds, proposed.closeTime) !== proposed.fingerprint) conflict = true; }
        if (conflict) {
          await tx.query('UPDATE app_settings SET value=$2::jsonb,updated_at=NOW() WHERE key=$1', [fenceKey, JSON.stringify({ version: 1, quarantined: true })]);
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

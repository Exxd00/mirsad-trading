import 'server-only';
import { query, type SqlExecutor } from '../db';
import { decimal } from '../execution/v1/model';
import { COINBASE_REFERENCE_PROVIDER, CoinbaseMarketError, type CoinbasePricePoint, type CoinbasePriceStore } from './coinbase-market';

const PREFIX = `wallet:cow:minute-price:${COINBASE_REFERENCE_PROVIDER}:`;
type Value = { version: 1; provider: typeof COINBASE_REFERENCE_PROVIDER; productId: string;
  timeframeSeconds: 60; completed: true; at: number; price: string; conflict: boolean };
const fail = (code: 'coinbase_cache_invalid' | 'coinbase_cache_conflict' | 'coinbase_cache_unavailable'): never => { throw new CoinbaseMarketError(code); };
const product = (id: string) => { if (typeof id !== 'string' || !/^[A-Z0-9]{2,16}-EUR$/.test(id)) fail('coinbase_cache_invalid'); return id; };
const stamp = (at: number) => String(at).padStart(16, '0');
const key = (id: string, at: number) => `${PREFIX}${id}:${stamp(at)}`;
function point(p: CoinbasePricePoint, clock: () => number): CoinbasePricePoint {
  try {
    if (!p || !Number.isSafeInteger(p.at) || p.at < 0 || p.at % 60 || p.at > Math.floor(clock() / 60) * 60
      || typeof p.price !== 'string' || !decimal(p.price).gt(0)) return fail('coinbase_cache_invalid');
    return { at: p.at, price: decimal(p.price).toFixed() };
  } catch { return fail('coinbase_cache_invalid'); }
}
function value(raw: unknown, id: string, clock: () => number): Value {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('coinbase_cache_invalid');
  const v = raw as Value;
  if (v.version !== 1 || v.provider !== COINBASE_REFERENCE_PROVIDER || v.productId !== id || v.timeframeSeconds !== 60
    || v.completed !== true || typeof v.conflict !== 'boolean') return fail('coinbase_cache_invalid');
  if (v.conflict) return fail('coinbase_cache_conflict');
  const normalized = point(v, clock); if (v.price !== normalized.price) return fail('coinbase_cache_invalid');
  return v;
}

/** Existing app_settings PK supplies the product/minute range index. No new
 * credentials/schema or public route. Writes are short atomic evidence CAS;
 * source I/O happens before this adapter is called.
 * A changed closed candle keeps its original price and a durable conflict flag.
 * A subsequent read cannot quietly reuse it after the triggering error. */
export function createSqlCoinbasePriceStore(execute: SqlExecutor['query'] = query,
  clock: () => number = () => Math.floor(Date.now() / 1000)): CoinbasePriceStore {
  const safe = async <T>(work: () => Promise<T>) => { try { return await work(); } catch (error) {
    if (error instanceof CoinbaseMarketError) throw error; return fail('coinbase_cache_unavailable'); } };
  return {
    load: (productId, start, end) => safe(async () => {
      const id = product(productId);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start % 60 || end % 60 || end < start
        || end - start > 86400 || end > Math.floor(clock() / 60) * 60) return fail('coinbase_cache_invalid');
      const result = await execute<{ key: string; value: unknown }>(
        'SELECT key,value FROM app_settings WHERE key>$1 AND key<=$2 ORDER BY key LIMIT 1441', [key(id, start), key(id, end)]);
      if (result.rows.length > (end - start) / 60) return fail('coinbase_cache_invalid');
      const rows = result.rows.map(row => {
        const v = value(row.value, id, clock);
        if (row.key !== key(id, v.at) || v.at <= start || v.at > end) return fail('coinbase_cache_invalid');
        return { at: v.at, price: v.price };
      });
      if (new Set(rows.map(p => p.at)).size !== rows.length) return fail('coinbase_cache_invalid');
      return rows.sort((a, b) => a.at - b.at);
    }),
    save: (productId, points) => safe(async () => {
      const id = product(productId);
      if (!Array.isArray(points) || points.length > 1440) return fail('coinbase_cache_invalid');
      const unique = new Map<number, CoinbasePricePoint>();
      for (const p of points) {
        const normalized = point(p, clock), prior = unique.get(normalized.at);
        if (prior && prior.price !== normalized.price) return fail('coinbase_cache_conflict');
        unique.set(normalized.at, normalized);
      }
      if (!unique.size) return;
      const input = [...unique.values()].sort((a, b) => a.at - b.at).map(p => ({ key: key(id, p.at), value: {
        version: 1, provider: COINBASE_REFERENCE_PROVIDER, productId: id, timeframeSeconds: 60, completed: true,
        at: p.at, price: p.price, conflict: false,
      } satisfies Value }));
      const result = await execute<{ value: unknown }>(`INSERT INTO app_settings(key,value)
        SELECT incoming.key,incoming.value FROM jsonb_to_recordset($1::jsonb) AS incoming(key text,value jsonb) ORDER BY incoming.key
        ON CONFLICT(key) DO UPDATE SET value=CASE WHEN app_settings.value=EXCLUDED.value THEN app_settings.value
          ELSE jsonb_set(app_settings.value,'{conflict}','true'::jsonb,true) END
        RETURNING value`, [JSON.stringify(input)]);
      if (result.rows.length !== input.length) return fail('coinbase_cache_unavailable');
      // The single statement has committed its immutable records/conflict flags
      // before we report a revision. Never roll back and forget that conflict.
      for (const row of result.rows) value(row.value, id, clock);
    }),
  };
}
export const sqlCoinbasePriceStore = createSqlCoinbasePriceStore();

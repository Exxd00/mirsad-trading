import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { query, transaction, type SqlExecutor } from '../db';
import type { DiscoveryEvent, PaperPairState, UniverseState } from './model';

const prefix = 'discovery:paper:v1:';
export type DiscoveryRuntime = {
  universe: UniverseState; lastRunAt: number | null; lastSuccessAt: number | null;
  lastTickAt: number | null; lastError: string | null; nextSheetRow: number;
  sync: { lastSuccessAt: number | null; lastError: string | null };
  marketAttempts?: Record<string, number>;
};
export const initialRuntime = (): DiscoveryRuntime => ({
  universe: { baselineAt: null, lastObservedAt: null, pairs: {} },
  lastRunAt: null, lastSuccessAt: null, lastTickAt: null, lastError: null,
  nextSheetRow: 2, sync: { lastSuccessAt: null, lastError: null },
});
export type DiscoveryLease = { owner: string };
export type StoredEvent = { event: DiscoveryEvent; sheetRow: number; syncedAt: number | null };
const eventKey = (id: string) => prefix + 'event:' + createHash('sha256').update(id).digest('hex');
async function assertOwned(tx: SqlExecutor, lease: DiscoveryLease) {
  const r = await tx.query("SELECT key FROM app_settings WHERE key=$1 AND value->>'owner'=$2 AND (value->>'expires')::numeric>EXTRACT(EPOCH FROM clock_timestamp()) FOR UPDATE", [prefix + 'lock', lease.owner]);
  if (!r.rowCount) throw new Error('discovery_lock_lost');
}
export class DiscoveryJournal {
  async acquire(): Promise<DiscoveryLease | null> {
    const owner = randomUUID();
    return transaction(async tx => {
      await tx.query("INSERT INTO app_settings(key,value) VALUES($1,'{}'::jsonb) ON CONFLICT DO NOTHING", [prefix + 'lock']);
      const r = await tx.query("UPDATE app_settings SET value=jsonb_build_object('owner',$2::text,'expires',EXTRACT(EPOCH FROM clock_timestamp())+90),updated_at=NOW() WHERE key=$1 AND COALESCE((value->>'expires')::numeric,0)<=EXTRACT(EPOCH FROM clock_timestamp()) RETURNING key", [prefix + 'lock', owner]);
      return r.rowCount ? { owner } : null;
    });
  }
  async release(lease: DiscoveryLease) {
    await query("UPDATE app_settings SET value='{}'::jsonb,updated_at=NOW() WHERE key=$1 AND value->>'owner'=$2", [prefix + 'lock', lease.owner]);
  }
  async runtime(): Promise<DiscoveryRuntime> {
    const r = await query<{ value: DiscoveryRuntime }>('SELECT value FROM app_settings WHERE key=$1', [prefix + 'runtime']);
    return r.rows[0]?.value ?? initialRuntime();
  }
  async pairs(): Promise<PaperPairState[]> {
    const r = await query<{ value: PaperPairState }>("SELECT value FROM app_settings WHERE key LIKE $1 ORDER BY updated_at DESC", [prefix + 'pair:%']);
    return r.rows.map(r => r.value);
  }
  async events(limit = 60): Promise<StoredEvent[]> {
    const r = await query<{ value: StoredEvent }>("SELECT value FROM app_settings WHERE key LIKE $1 ORDER BY (value->>'sheetRow')::integer DESC LIMIT $2", [prefix + 'event:%', limit]);
    return r.rows.map(r => r.value);
  }
  async pending(limit = 60): Promise<StoredEvent[]> {
    const r = await query<{ value: StoredEvent }>("SELECT value FROM app_settings WHERE key LIKE $1 AND value->>'syncedAt' IS NULL ORDER BY (value->>'sheetRow')::integer LIMIT $2", [prefix + 'event:%', limit]);
    return r.rows.map(r => r.value);
  }
  async pendingCount(): Promise<number> {
    const r = await query<{ count: string }>("SELECT COUNT(*)::text AS count FROM app_settings WHERE key LIKE $1 AND value->>'syncedAt' IS NULL", [prefix + 'event:%']);
    return Number(r.rows[0]?.count ?? 0);
  }
  /** State, pair updates, immutable audit events and outbox rows commit together. */
  async save(lease: DiscoveryLease, runtime: DiscoveryRuntime, pairs: PaperPairState[] = [], events: DiscoveryEvent[] = []) {
    let nextSheetRow = runtime.nextSheetRow;
    await transaction(async tx => {
      await assertOwned(tx, lease);
      const uniquePairs = [...new Map(pairs.map(p => [p.symbol, p])).values()];
      if (uniquePairs.length) await tx.query("INSERT INTO app_settings(key,value) SELECT item->>'key',item->'value' FROM jsonb_array_elements($1::jsonb) AS item ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()", [JSON.stringify(uniquePairs.map(value => ({ key: prefix + 'pair:' + value.symbol, value })))]);
      const uniqueEvents = [...new Map(events.map(e => [e.id, e])).values()];
      if (uniqueEvents.length) {
        const existing = await tx.query<{ key: string }>('SELECT key FROM app_settings WHERE key=ANY($1::text[])', [uniqueEvents.map(e => eventKey(e.id))]);
        const seen = new Set(existing.rows.map(r => r.key));
        const fresh = uniqueEvents.filter(e => !seen.has(eventKey(e.id))).map(event => ({ key: eventKey(event.id), value: { event, sheetRow: nextSheetRow++, syncedAt: null } satisfies StoredEvent }));
        if (fresh.length) await tx.query("INSERT INTO app_settings(key,value) SELECT item->>'key',item->'value' FROM jsonb_array_elements($1::jsonb) AS item ON CONFLICT DO NOTHING", [JSON.stringify(fresh)]);
      }
      await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()', [prefix + 'runtime', JSON.stringify({ ...runtime, nextSheetRow })]);
    });
    runtime.nextSheetRow = nextSheetRow;
  }
  async acknowledge(lease: DiscoveryLease, records: StoredEvent[], at: number) {
    await transaction(async tx => {
      await assertOwned(tx, lease);
      for (const record of records) await tx.query("UPDATE app_settings SET value=jsonb_set(value,'{syncedAt}',$2::jsonb),updated_at=NOW() WHERE key=$1 AND value->>'syncedAt' IS NULL", [eventKey(record.event.id), JSON.stringify(at)]);
    });
  }
}

import 'server-only';
import { randomUUID } from 'node:crypto';
import { query, transaction, type SqlExecutor } from '../../db';
import { VERSION, type IndicatorState, type Intent, type RiskState, type Signal, type SourceOrder } from './model';
export type RuntimeState = { risk: RiskState; indicators: Record<string, IndicatorState>; pendingSignals: Signal[]; entriesEnabled: boolean; scanCursor?: number;
  dailyReportDate?: string; dailyReport?: Record<string, unknown>; lastSuccessfulReport?: Record<string, unknown> };
export type DecisionRecord = { key: string; signalId: string | null; intent: Intent; status: 'attempting' | 'unknown' | 'acknowledged' | 'absent'; source: SourceOrder | null; recordedAt: number };
export type Lease = { key: string; owner: string };
export interface Journal {
  acquire(accountId: string): Promise<Lease | null>; release(lease: Lease): Promise<void>;
  renew(lease: Lease): Promise<void>; state(lease: Lease): Promise<RuntimeState>;
  save(lease: Lease, state: RuntimeState): Promise<void>; decision(lease: Lease, key: string): Promise<DecisionRecord | null>;
  begin(lease: Lease, intent: Intent, now: number): Promise<boolean>;
  result(lease: Lease, key: string, status: DecisionRecord['status'], source: SourceOrder | null): Promise<void>;
  unresolved(lease: Lease): Promise<DecisionRecord[]>;
  event(lease: Lease, value: Record<string, unknown>): Promise<void>;
}
export const initialState = (): RuntimeState => ({ risk: { reduced: false, dailyHaltDate: null }, indicators: {}, pendingSignals: [], entriesEnabled: false });
const root = (accountId: string) => `execution:v1:${accountId}`;
export class SqlJournal implements Journal {
  async acquire(accountId: string) {
    const key = `${root(accountId)}:lock`, owner = randomUUID();
    return transaction(async tx => {
      await tx.query("INSERT INTO app_settings(key,value) VALUES($1,'{}'::jsonb) ON CONFLICT DO NOTHING", [key]);
      const r = await tx.query("UPDATE app_settings SET value=jsonb_build_object('owner',$2::text,'expires',EXTRACT(EPOCH FROM clock_timestamp())+120),updated_at=NOW() WHERE key=$1 AND COALESCE((value->>'expires')::numeric,0)<=EXTRACT(EPOCH FROM clock_timestamp()) RETURNING key", [key, owner]);
      return r.rowCount ? { key, owner } : null;
    });
  }
  private async owned(tx: SqlExecutor, lease: Lease) {
    const r = await tx.query("SELECT key FROM app_settings WHERE key=$1 AND value->>'owner'=$2 AND (value->>'expires')::numeric>EXTRACT(EPOCH FROM clock_timestamp()) FOR UPDATE", [lease.key, lease.owner]);
    if (!r.rowCount) throw new Error('execution_lock_lost');
  }
  private path(lease: Lease, suffix: string) { return lease.key.replace(/:lock$/, `:${suffix}`); }
  async release(lease: Lease) { await query("UPDATE app_settings SET value='{}'::jsonb,updated_at=NOW() WHERE key=$1 AND value->>'owner'=$2", [lease.key, lease.owner]); }
  async renew(lease: Lease) { await transaction(async tx => { await this.owned(tx, lease); await tx.query("UPDATE app_settings SET value=jsonb_set(value,'{expires}',to_jsonb(EXTRACT(EPOCH FROM clock_timestamp())+120)),updated_at=NOW() WHERE key=$1", [lease.key]); }); }
  async state(lease: Lease) {
    return transaction(async tx => { await this.owned(tx, lease); const r = await tx.query<{ value: RuntimeState }>('SELECT value FROM app_settings WHERE key=$1', [this.path(lease, 'state')]); return r.rows[0]?.value ?? initialState(); });
  }
  async save(lease: Lease, state: RuntimeState) {
    await transaction(async tx => { await this.owned(tx, lease); await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()', [this.path(lease, 'state'), JSON.stringify(state)]); });
  }
  async decision(lease: Lease, key: string) {
    const r = await query<{ value: DecisionRecord }>('SELECT value FROM app_settings WHERE key=$1', [this.path(lease, `decision:${key}`)]); return r.rows[0]?.value ?? null;
  }
  async begin(lease: Lease, intent: Intent, now: number) {
    return transaction(async tx => {
      await this.owned(tx, lease);
      const record: DecisionRecord = { key: intent.key, signalId: intent.signal?.id ?? null, intent, status: 'attempting', source: null, recordedAt: now };
      const r = await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING key', [this.path(lease, `decision:${intent.key}`), JSON.stringify(record)]);
      return r.rowCount > 0;
    });
  }
  async result(lease: Lease, key: string, status: DecisionRecord['status'], source: SourceOrder | null) {
    await transaction(async tx => { await this.owned(tx, lease); await tx.query("UPDATE app_settings SET value=value || $2::jsonb,updated_at=NOW() WHERE key=$1", [this.path(lease, `decision:${key}`), JSON.stringify({ status, source })]); });
  }
  async unresolved(lease: Lease) {
    const r = await query<{ value: DecisionRecord }>("SELECT value FROM app_settings WHERE key LIKE $1 AND value->>'status' IN ('unknown','attempting')", [this.path(lease, 'decision:%')]); return r.rows.map(r => r.value);
  }
  async event(lease: Lease, value: Record<string, unknown>) {
    await transaction(async tx => { await this.owned(tx, lease); await tx.query('INSERT INTO audit_events(event,detail) VALUES($1,$2)', ['execution.v1', JSON.stringify({ version: VERSION, accountId: lease.key.split(':')[2], ...value })]); });
  }
}

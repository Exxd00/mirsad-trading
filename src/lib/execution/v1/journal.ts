import 'server-only';
import { randomUUID } from 'node:crypto';
import { query, transaction, type SqlExecutor } from '../../db';
import type { RevolutTransaction } from '../../brokers/revolut';
import { VERSION, type IndicatorState, type Intent, type RiskState, type Signal, type SourceOrder } from './model';
import type { ProtectionLevels } from './protection';
import type { AccountingEvidence } from './accounting';
export type RuntimeState = { risk: RiskState; indicators: Record<string, IndicatorState>; pendingSignals: Signal[]; entriesEnabled: boolean; scanCursor?: number;
  // Armed by the owner's execution switch, never by deployment or a scheduler.
  // Pausing entries does not remove protection from already managed fills.
  executionArmed?: boolean;
  dailyReportDate?: string; dailyReport?: Record<string, unknown>; lastSuccessfulReport?: Record<string, unknown> };
export type DecisionRecord = { key: string; signalId: string | null; intent: Intent; status: 'attempting' | 'unknown' | 'acknowledged' | 'absent'; source: SourceOrder | null; recordedAt: number;
  // Created atomically with a new intent. Older records are never assigned a
  // replacement identity: their original source outcome must remain unresolved.
  sourceIdentity?: { clientOrderId: string; venueOrderId?: string }; protectionMode?: 'mirsad' };
export type ManagedProtection = ProtectionLevels & { entryKey: string; entryOrderId: string; symbol: string;
  entryFilled: string; exitedQuantity: string; sourceAt: number; updatedAt: number;
  status: 'watching' | 'triggered' | 'closing' | 'closed' | 'blocked';
  trigger: { reason: 'stop' | 'target' | 'reverse_cross'; at: number; bid: string | null } | null;
  lastError: string | null };
export type ProtectionHeartbeat = { at: number; status: 'idle' | 'watching' | 'blocked' | 'busy';
  managedPositions: number; checkedPositions: number; errors: { symbol?: string; reason: string }[] };
export type SourceWrite = { id: string; decisionKey: string; symbol: string; kind: 'submit' | 'cancel';
  sourceOrderId: string | null; startedAt: number; settledAt: number | null };
export type SourceArchiveState = { version: 1; observedFromMs: number; windowStartMs: number; windowEndMs: number;
  cursor: string | null; cursors: string[]; scannedUntilMs: number | null; sourceAtMs: number | null;
  lastReadAtMs: number | null; lastError: string | null };
export type Lease = { key: string; owner: string };
export interface Journal {
  acquire(accountId: string): Promise<Lease | null>; release(lease: Lease): Promise<void>;
  renew(lease: Lease): Promise<void>; state(lease: Lease): Promise<RuntimeState>;
  save(lease: Lease, state: RuntimeState): Promise<void>; decision(lease: Lease, key: string): Promise<DecisionRecord | null>;
  begin(lease: Lease, intent: Intent, now: number): Promise<boolean>;
  result(lease: Lease, key: string, status: DecisionRecord['status'], source: SourceOrder | null): Promise<void>;
  unresolved(lease: Lease): Promise<DecisionRecord[]>;
  accountDecisions(accountId: string): Promise<DecisionRecord[]>;
  accounting(accountId: string): Promise<AccountingEvidence | null>;
  saveAccounting(lease: Lease, value: AccountingEvidence, expectedCheckedAt: number): Promise<boolean>;
  sourceArchive(lease: Lease): Promise<SourceArchiveState | null>;
  saveSourceArchive(lease: Lease, state: SourceArchiveState, records: RevolutTransaction[]): Promise<void>;
  protections(accountId: string): Promise<ManagedProtection[]>;
  saveProtection(lease: Lease, value: ManagedProtection): Promise<void>;
  protectionHeartbeat(accountId: string): Promise<ProtectionHeartbeat | null>;
  saveProtectionHeartbeat(lease: Lease, value: ProtectionHeartbeat): Promise<void>;
  sourceWrites(lease: Lease): Promise<SourceWrite[]>;
  claimSourceWrite(lease: Lease, value: SourceWrite): Promise<boolean>;
  settleSourceWrite(lease: Lease, id: string, at: number): Promise<void>;
  noteSourceOrderId(lease: Lease, key: string, clientOrderId: string, venueOrderId: string): Promise<void>;
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
    return transaction(async tx => { await this.owned(tx, lease);
      const r = await tx.query<{ value: DecisionRecord }>('SELECT value FROM app_settings WHERE key=$1', [this.path(lease, `decision:${key}`)]); return r.rows[0]?.value ?? null;
    });
  }
  async begin(lease: Lease, intent: Intent, now: number) {
    return transaction(async tx => {
      await this.owned(tx, lease);
      const record: DecisionRecord = { key: intent.key, signalId: intent.signal?.id ?? null, intent, status: 'attempting', source: null, recordedAt: now,
        sourceIdentity: { clientOrderId: randomUUID() }, ...(intent.side === 'buy' ? { protectionMode: 'mirsad' as const } : {}) };
      const r = await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING key', [this.path(lease, `decision:${intent.key}`), JSON.stringify(record)]);
      return r.rowCount > 0;
    });
  }
  async result(lease: Lease, key: string, status: DecisionRecord['status'], source: SourceOrder | null) {
    await transaction(async tx => {
      await this.owned(tx, lease);
      const r = await tx.query<{ value: DecisionRecord }>('SELECT value FROM app_settings WHERE key=$1', [this.path(lease, `decision:${key}`)]);
      const old = r.rows[0]?.value;
      // A later transport error must not erase an acknowledged source ID or a
      // proven pre-send rejection. Cancellation uncertainty has its own claim.
      const nextStatus = status === 'unknown' && (old?.status === 'acknowledged' || old?.status === 'absent') ? old.status : status;
      await tx.query("UPDATE app_settings SET value=value || $2::jsonb,updated_at=NOW() WHERE key=$1",
        [this.path(lease, `decision:${key}`), JSON.stringify({ status: nextStatus, source: source ?? old?.source ?? null })]);
    });
  }
  async unresolved(lease: Lease) {
    const r = await query<{ value: DecisionRecord }>("SELECT value FROM app_settings WHERE key LIKE $1 AND value->>'status' IN ('unknown','attempting')", [this.path(lease, 'decision:%')]); return r.rows.map(r => r.value);
  }
  async accountDecisions(accountId: string) {
    // Read-only reports may observe decisions without taking the execution lock.
    // Submission and deadline lookups still use decision(lease, key).
    const r = await query<{ value: DecisionRecord }>('SELECT value FROM app_settings WHERE key LIKE $1', [`${root(accountId)}:decision:%`]);
    return r.rows.map(row => row.value);
  }
  async sourceArchive(lease: Lease) {
    return transaction(async tx => { await this.owned(tx, lease);
      const r = await tx.query<{ value: SourceArchiveState }>('SELECT value FROM app_settings WHERE key=$1', [this.path(lease, 'source_archive')]);
      return r.rows[0]?.value ?? null;
    });
  }
  async accounting(accountId: string) {
    const r = await query<{ value: AccountingEvidence }>('SELECT value FROM app_settings WHERE key=$1', [`${root(accountId)}:accounting`]);
    return r.rows[0]?.value ?? null;
  }
  async saveAccounting(lease: Lease, value: AccountingEvidence, expectedCheckedAt: number) {
    return transaction(async tx => {
      await this.owned(tx, lease);
      const key = this.path(lease, 'accounting');
      const old = await tx.query<{ value: AccountingEvidence }>('SELECT value FROM app_settings WHERE key=$1', [key]);
      if ((old.rows[0]?.value.checkedAt ?? 0) !== expectedCheckedAt) return false;
      await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()', [key, JSON.stringify(value)]);
      return true;
    });
  }
  async saveSourceArchive(lease: Lease, state: SourceArchiveState, records: RevolutTransaction[]) {
    if (records.some(record => record.accountId !== lease.key.split(':')[2])) throw new Error('source_archive_account_mismatch');
    await transaction(async tx => {
      await this.owned(tx, lease);
      for (const record of records) await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()',
        [this.path(lease, `source_transaction:${record.id}`), JSON.stringify({ sourceAtMs: state.sourceAtMs, record })]);
      // Records and their continuation cursor are committed together.
      await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()',
        [this.path(lease, 'source_archive'), JSON.stringify(state)]);
    });
  }
  async event(lease: Lease, value: Record<string, unknown>) {
    await transaction(async tx => { await this.owned(tx, lease); await tx.query('INSERT INTO audit_events(event,detail) VALUES($1,$2)', ['execution.v1', JSON.stringify({ version: VERSION, accountId: lease.key.split(':')[2], ...value })]); });
  }
  async protections(accountId: string) {
    const r = await query<{ value: ManagedProtection }>('SELECT value FROM app_settings WHERE key LIKE $1', [`${root(accountId)}:protection:%`]);
    return r.rows.map(row => row.value);
  }
  async saveProtection(lease: Lease, value: ManagedProtection) {
    await transaction(async tx => { await this.owned(tx, lease);
      await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()',
        [this.path(lease, `protection:${value.entryKey}`), JSON.stringify(value)]);
    });
  }
  async protectionHeartbeat(accountId: string) {
    const r = await query<{ value: ProtectionHeartbeat }>('SELECT value FROM app_settings WHERE key=$1', [`${root(accountId)}:protection_heartbeat`]);
    return r.rows[0]?.value ?? null;
  }
  async saveProtectionHeartbeat(lease: Lease, value: ProtectionHeartbeat) {
    await transaction(async tx => { await this.owned(tx, lease);
      await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()',
        [this.path(lease, 'protection_heartbeat'), JSON.stringify(value)]);
    });
  }
  async sourceWrites(lease: Lease) {
    return transaction(async tx => { await this.owned(tx, lease);
      const r = await tx.query<{ value: SourceWrite }>('SELECT value FROM app_settings WHERE key LIKE $1', [this.path(lease, 'write:%')]);
      return r.rows.map(row => row.value);
    });
  }
  async claimSourceWrite(lease: Lease, value: SourceWrite) {
    return transaction(async tx => {
      await this.owned(tx, lease);
      const state = await tx.query<{ value: RuntimeState }>('SELECT value FROM app_settings WHERE key=$1', [this.path(lease, 'state')]);
      if (state.rows[0]?.value.executionArmed !== true) throw new Error('execution_not_armed');
      const decision = await tx.query<{ value: DecisionRecord }>('SELECT value FROM app_settings WHERE key=$1', [this.path(lease, `decision:${value.decisionKey}`)]);
      if (!decision.rows[0]?.value.sourceIdentity || decision.rows[0].value.intent.symbol !== value.symbol) throw new Error('source_write_identity_missing');
      const writes = await tx.query<{ value: SourceWrite }>('SELECT value FROM app_settings WHERE key LIKE $1', [this.path(lease, 'write:%')]);
      // A source request has no fencing-token support. This non-expiring claim
      // survives lease expiry and prevents a second writer until source proof.
      if (writes.rows.some(row => row.value.id === value.id || (row.value.symbol === value.symbol && row.value.settledAt === null))) return false;
      const r = await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING key',
        [this.path(lease, `write:${value.id}`), JSON.stringify({ ...value, settledAt: null })]);
      return r.rowCount > 0;
    });
  }
  async settleSourceWrite(lease: Lease, id: string, at: number) {
    await transaction(async tx => { await this.owned(tx, lease);
      await tx.query("UPDATE app_settings SET value=value || $2::jsonb,updated_at=NOW() WHERE key=$1", [this.path(lease, `write:${id}`), JSON.stringify({ settledAt: at })]);
    });
  }
  async noteSourceOrderId(lease: Lease, key: string, clientOrderId: string, venueOrderId: string) {
    await transaction(async tx => {
      await this.owned(tx, lease);
      const r = await tx.query<{ value: DecisionRecord }>('SELECT value FROM app_settings WHERE key=$1', [this.path(lease, `decision:${key}`)]);
      if (r.rows[0]?.value.sourceIdentity?.clientOrderId !== clientOrderId) throw new Error('source_identity_mismatch');
      await tx.query("UPDATE app_settings SET value=jsonb_set(value,'{sourceIdentity,venueOrderId}',to_jsonb($2::text)),updated_at=NOW() WHERE key=$1",
        [this.path(lease, `decision:${key}`), venueOrderId]);
    });
  }
}

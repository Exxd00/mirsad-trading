import 'server-only';
import { isDeepStrictEqual } from 'node:util';
import { keccak256, type Address, type Hex } from 'viem';
import type { SqlExecutor } from '../db';
import { CONFIG, type Intent } from '../execution/v1/model';
import type { DecisionRecord, Lease, RuntimeState, SourceWrite } from '../execution/v1/journal';
import { cowFail, type CowFinalizedArchive, type CowOrderRecord, type CowPreparedTx, type CowTxPhase, type CowTxRecord } from './cow-execution-types';

export type CowJournalOptions = { bindingId: string; chainId: number; executor: Address; query: SqlExecutor['query'];
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  codec: { seal(value: string, context: string): string; open(value: string, context: string): string } };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^0x[0-9a-f]{64}$/i, uid = /^0x[0-9a-f]{112}$/i;
const validNonce = (n: number) => Number.isSafeInteger(n) && n >= 0 && n < Number.MAX_SAFE_INTEGER;

/** Separate protocol journal. Every mutation is fenced by the real account
 * lease and original decision. Signed transaction envelopes are encrypted by
 * the caller's host codec, never exposed in public status DTOs or logs. */
export class CowExecutionJournal {
  readonly bindingId: string;
  private readonly prefix: string;
  constructor(private readonly options: CowJournalOptions) {
    if (!hash.test(options.bindingId) || options.chainId !== 1 || !/^0x[0-9a-f]{40}$/i.test(options.executor)
      || /^0x0{40}$/i.test(options.executor) || !options.codec) cowFail('cow_journal_configuration_invalid');
    this.bindingId = options.bindingId.toLowerCase(); this.prefix = `wallet:cow:v1:${this.bindingId}:`;
  }
  private orderKey(id: string) { if (!uuid.test(id)) cowFail('cow_client_identity_invalid'); return this.prefix + 'order:' + id.toLowerCase(); }
  private txKey(id: Hex, phase: CowTxPhase) {
    if (!uid.test(id) || !['presign', 'cancel', 'clear-presign'].includes(phase)) cowFail('cow_transaction_identity_invalid');
    return this.prefix + 'tx:' + id.toLowerCase() + ':' + phase;
  }
  private async fenced(tx: SqlExecutor, lease: Lease, decisionKey: string, expected?: Intent) {
    const root = `execution:v1:${CONFIG.accountId}`;
    if (lease.key !== root + ':lock' || !hash.test('0x' + decisionKey)) cowFail('cow_execution_context_invalid');
    const owned = await tx.query("SELECT key FROM app_settings WHERE key=$1 AND value->>'owner'=$2 AND (value->>'expires')::numeric>EXTRACT(EPOCH FROM clock_timestamp()) FOR UPDATE", [lease.key, lease.owner]);
    if (owned.rowCount !== 1) cowFail('execution_lock_lost');
    const state = await tx.query<{ value: RuntimeState }>('SELECT value FROM app_settings WHERE key=$1', [root + ':state']);
    if (state.rows[0]?.value.executionArmed !== true) cowFail('execution_not_armed');
    const row = await tx.query<{ value: DecisionRecord }>('SELECT value FROM app_settings WHERE key=$1', [root + ':decision:' + decisionKey]);
    const decision = row.rows[0]?.value;
    if (!decision?.sourceIdentity || decision.key !== decisionKey || (expected && !isDeepStrictEqual(decision.intent, expected))) cowFail('source_intent_mismatch');
    return decision;
  }
  private decodeTx(value: unknown, key: string): CowTxRecord {
    try {
      if (typeof value !== 'string') return cowFail('cow_journal_corrupt');
      const parsed = JSON.parse(this.options.codec.open(value, key)) as CowTxRecord;
      if (parsed.version !== 1 || !Number.isSafeInteger(parsed.revision) || parsed.revision < 1 || !uid.test(parsed.uid)
        || !validNonce(parsed.nonce) || !Array.isArray(parsed.attempts) || !Array.isArray(parsed.broadcastHashes)) return cowFail('cow_journal_corrupt');
      for (const item of parsed.attempts) if (!/^0x[0-9a-f]+$/i.test(item.raw) || keccak256(item.raw) !== item.hash
        || item.nonce !== parsed.nonce || item.chainId !== this.options.chainId
        || item.from.toLowerCase() !== this.options.executor.toLowerCase()) return cowFail('cow_journal_corrupt');
      return parsed;
    } catch { return cowFail('cow_journal_corrupt'); }
  }
  private async writeTx(tx: SqlExecutor, key: string, record: CowTxRecord) {
    const encrypted = this.options.codec.seal(JSON.stringify(record), key);
    await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()', [key, JSON.stringify(encrypted)]);
  }
  async getRecord(identity: string): Promise<CowOrderRecord | null> {
    const result = uuid.test(identity)
      ? await this.options.query<{ value: CowOrderRecord }>('SELECT value FROM app_settings WHERE key=$1', [this.orderKey(identity)])
      : uid.test(identity) ? await this.options.query<{ value: CowOrderRecord }>('SELECT value FROM app_settings WHERE key LIKE $1 AND value->>\'uid\'=$2', [this.prefix + 'order:%', identity.toLowerCase()]) : cowFail('cow_order_identity_invalid');
    if (result.rows.length > 1) cowFail('cow_order_identity_conflict');
    const value = result.rows[0]?.value;
    if (value && (value.version !== 1 || value.bindingId !== this.bindingId || !uuid.test(value.clientOrderId) || !uid.test(value.uid))) cowFail('cow_journal_corrupt');
    return value ?? null;
  }
  async records(): Promise<CowOrderRecord[]> {
    const rows = await this.options.query<{ value: CowOrderRecord }>('SELECT value FROM app_settings WHERE key LIKE $1 ORDER BY key', [this.prefix + 'order:%']);
    return Promise.all(rows.rows.map(row => this.getRecord(row.value.clientOrderId).then(record => record ?? cowFail('cow_journal_corrupt'))));
  }
  async createOrder(lease: Lease, record: Omit<CowOrderRecord, 'version' | 'revision' | 'bindingId'>): Promise<CowOrderRecord> {
    return this.options.transaction(async tx => {
      const decision = await this.fenced(tx, lease, record.decisionKey, record.intent);
      if (decision.sourceIdentity!.clientOrderId !== record.clientOrderId || !uid.test(record.uid)) cowFail('source_intent_mismatch');
      const root = `execution:v1:${CONFIG.accountId}`;
      const claim = await tx.query<{ value: SourceWrite }>('SELECT value FROM app_settings WHERE key=$1', [root + ':write:submit:' + record.decisionKey]);
      if (claim.rows[0]?.value.decisionKey !== record.decisionKey || claim.rows[0].value.symbol !== record.intent.symbol
        || claim.rows[0].value.kind !== 'submit' || claim.rows[0].value.settledAt !== null) cowFail('source_write_identity_missing');
      const key = this.orderKey(record.clientOrderId), existing = await tx.query<{ value: CowOrderRecord }>('SELECT value FROM app_settings WHERE key=$1', [key]);
      if (existing.rowCount) {
        const old = existing.rows[0].value;
        if (old.uid !== record.uid || !isDeepStrictEqual(old.intent, record.intent) || !isDeepStrictEqual(old.order, record.order)
          || old.fullAppData !== record.fullAppData || !isDeepStrictEqual(old.conversion, record.conversion)) cowFail('cow_order_identity_conflict');
        return old;
      }
      const value: CowOrderRecord = { ...record, bindingId: this.bindingId, version: 1, revision: 1 };
      await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)', [key, JSON.stringify(value)]); return value;
    });
  }
  async updateOrder(lease: Lease, record: CowOrderRecord, patch: Pick<CowOrderRecord, 'postState' | 'cancelRequested' | 'lastError'>): Promise<CowOrderRecord> {
    return this.options.transaction(async tx => {
      await this.fenced(tx, lease, record.decisionKey, record.intent);
      const key = this.orderKey(record.clientOrderId), row = await tx.query<{ value: CowOrderRecord }>('SELECT value FROM app_settings WHERE key=$1 FOR UPDATE', [key]);
      const old = row.rows[0]?.value;
      if (!old || old.revision !== record.revision || old.uid !== record.uid) cowFail('cow_journal_revision_conflict');
      const value = { ...old, ...patch, postState: old.postState === 'accepted' ? 'accepted' as const : patch.postState,
        cancelRequested: old.cancelRequested || patch.cancelRequested, revision: old.revision + 1 };
      await tx.query('UPDATE app_settings SET value=$2::jsonb,updated_at=NOW() WHERE key=$1', [key, JSON.stringify(value)]); return value;
    });
  }
  async getTransaction(id: Hex, phase: CowTxPhase): Promise<CowTxRecord | null> {
    const key = this.txKey(id, phase), row = await this.options.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [key]);
    return row.rowCount ? this.decodeTx(row.rows[0].value, key) : null;
  }
  async getFinalizedArchive(id: Hex): Promise<CowFinalizedArchive | null> {
    if (!uid.test(id)) return cowFail('cow_order_identity_invalid');
    const key = this.prefix + 'proof:' + id.toLowerCase();
    const row = await this.options.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [key]);
    if (!row.rowCount) return null;
    try {
      if (typeof row.rows[0].value !== 'string') return cowFail('cow_journal_corrupt');
      const archive = JSON.parse(this.options.codec.open(row.rows[0].value, key)) as CowFinalizedArchive;
      if (archive.version !== 1 || archive.uid !== id || !/^(0|[1-9][0-9]*)$/.test(archive.through.number)
        || !hash.test(archive.through.hash) || !Array.isArray(archive.trades)) return cowFail('cow_journal_corrupt');
      return archive;
    } catch { return cowFail('cow_journal_corrupt'); }
  }
  /** Authoritative local absence: every broadcast requires saved bytes first.
   * This terminal proof cannot be inferred from an API 404 or RPC timeout. */
  async markNeverSubmitted(lease: Lease, record: CowOrderRecord, now: number): Promise<CowOrderRecord> {
    return this.options.transaction(async tx => {
      await this.fenced(tx, lease, record.decisionKey, record.intent);
      const orderKey = this.orderKey(record.clientOrderId), row = await tx.query<{ value: CowOrderRecord }>('SELECT value FROM app_settings WHERE key=$1 FOR UPDATE', [orderKey]);
      const current = row.rows[0]?.value;
      if (!current || current.uid !== record.uid) return cowFail('cow_order_identity_invalid');
      if (current.neverSubmitted) return current;
      if (current.postState !== 'not-posted' || !Number.isSafeInteger(now) || now < current.createdAt) return cowFail('cow_absence_not_proven');
      let allocated: CowTxRecord | null = null;
      for (const phase of ['presign', 'cancel', 'clear-presign'] as const) {
        const key = this.txKey(current.uid, phase), item = await tx.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1 FOR UPDATE', [key]);
        if (!item.rowCount) continue;
        const value = this.decodeTx(item.rows[0].value, key);
        if (value.attempts.length || value.broadcastHashes.length || phase !== 'presign') return cowFail('cow_absence_not_proven');
        allocated = value;
      }
      let nonceReleased = !allocated;
      if (allocated) {
        const lane = `wallet:cow:v1:nonce:${this.options.chainId}:${this.options.executor.toLowerCase()}`;
        const counter = await tx.query<{ value: { nextNonce?: number } }>('SELECT value FROM app_settings WHERE key=$1 FOR UPDATE', [lane]);
        if (counter.rows[0]?.value.nextNonce === allocated.nonce + 1) {
          await tx.query('UPDATE app_settings SET value=$2::jsonb,updated_at=NOW() WHERE key=$1', [lane, JSON.stringify({ nextNonce: allocated.nonce })]);
          nonceReleased = true;
        }
      }
      const next: CowOrderRecord = { ...current, revision: current.revision + 1, cancelRequested: true,
        lastError: nonceReleased ? null : 'cow_nonce_gap_requires_clearance', neverSubmitted: { at: now, nonceReleased } };
      await tx.query('UPDATE app_settings SET value=$2::jsonb,updated_at=NOW() WHERE key=$1', [orderKey, JSON.stringify(next)]);
      await tx.query('INSERT INTO audit_events(event,detail) VALUES($1,$2::jsonb)', ['wallet.cow.never_submitted',
        JSON.stringify({ accountId: CONFIG.accountId, decisionKey: current.decisionKey, nonceReleased })]);
      return next;
    });
  }
  async saveFinalizedArchive(lease: Lease, record: CowOrderRecord, archive: CowFinalizedArchive): Promise<void> {
    await this.options.transaction(async tx => {
      await this.fenced(tx, lease, record.decisionKey, record.intent);
      if (archive.version !== 1 || archive.uid !== record.uid || BigInt(archive.through.number) < BigInt(record.createdBlock)
        || !hash.test(archive.through.hash) || archive.trades.length > 10000
        || archive.trades.some(t => t.uid !== record.uid || t.owner.toLowerCase() !== record.owner.toLowerCase()
          || t.sellToken.toLowerCase() !== record.order.sellToken.toLowerCase() || t.buyToken.toLowerCase() !== record.order.buyToken.toLowerCase()
          || BigInt(t.block.number) > BigInt(archive.through.number))) return cowFail('cow_finalized_archive_invalid');
      const key = this.prefix + 'proof:' + record.uid, oldRow = await tx.query<{ value: string }>('SELECT value FROM app_settings WHERE key=$1 FOR UPDATE', [key]);
      if (oldRow.rowCount) {
        const old = JSON.parse(this.options.codec.open(oldRow.rows[0].value, key)) as CowFinalizedArchive;
        if (BigInt(old.through.number) > BigInt(archive.through.number)
          || (old.through.number === archive.through.number && old.through.hash !== archive.through.hash)
          || old.trades.some(t => !archive.trades.some(n => n.transactionHash === t.transactionHash && n.logIndex === t.logIndex && isDeepStrictEqual(n, t)))) return cowFail('cow_finalized_archive_conflict');
      }
      const sealed = this.options.codec.seal(JSON.stringify(archive), key);
      await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()', [key, JSON.stringify(sealed)]);
    });
  }
  async allocate(lease: Lease, record: CowOrderRecord, phase: CowTxPhase, pendingNonce: number, now: number): Promise<CowTxRecord> {
    if (!validNonce(pendingNonce) || !Number.isSafeInteger(now) || now < 0) cowFail('cow_transaction_identity_invalid');
    return this.options.transaction(async tx => {
      await this.fenced(tx, lease, record.decisionKey, record.intent);
      const stored = await tx.query<{ value: CowOrderRecord }>('SELECT value FROM app_settings WHERE key=$1 FOR UPDATE', [this.orderKey(record.clientOrderId)]);
      if (stored.rows[0]?.value.neverSubmitted) return cowFail('cow_order_never_submitted');
      const key = this.txKey(record.uid, phase), found = await tx.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [key]);
      if (found.rowCount) return this.decodeTx(found.rows[0].value, key);
      let nonce: number;
      if (phase === 'clear-presign') {
        const originalKey = this.txKey(record.uid, 'presign'), original = await tx.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [originalKey]);
        if (!original.rowCount) return cowFail('cow_presign_missing');
        nonce = this.decodeTx(original.rows[0].value, originalKey).nonce;
      } else {
        const lane = `wallet:cow:v1:nonce:${this.options.chainId}:${this.options.executor.toLowerCase()}`;
        await tx.query("INSERT INTO app_settings(key,value) VALUES($1,'{}'::jsonb) ON CONFLICT DO NOTHING", [lane]);
        const row = await tx.query<{ value: { nextNonce?: number } }>('SELECT value FROM app_settings WHERE key=$1 FOR UPDATE', [lane]);
        const next = row.rows[0].value.nextNonce;
        if (next !== undefined && !validNonce(next)) cowFail('cow_journal_corrupt');
        nonce = Math.max(next ?? 0, pendingNonce);
        await tx.query('UPDATE app_settings SET value=$2::jsonb,updated_at=NOW() WHERE key=$1', [lane, JSON.stringify({ nextNonce: nonce + 1 })]);
      }
      const value: CowTxRecord = { version: 1, revision: 1, uid: record.uid, phase, nonce, createdAt: now, attempts: [], broadcastHashes: [] };
      await this.writeTx(tx, key, value); return value;
    });
  }
  async savePrepared(lease: Lease, order: CowOrderRecord, record: CowTxRecord, prepared: CowPreparedTx): Promise<CowTxRecord> {
    return this.options.transaction(async tx => {
      await this.fenced(tx, lease, order.decisionKey, order.intent);
      const stored = await tx.query<{ value: CowOrderRecord }>('SELECT value FROM app_settings WHERE key=$1 FOR UPDATE', [this.orderKey(order.clientOrderId)]);
      if (stored.rows[0]?.value.neverSubmitted) return cowFail('cow_order_never_submitted');
      const key = this.txKey(order.uid, record.phase), row = await tx.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1 FOR UPDATE', [key]);
      const old = row.rowCount ? this.decodeTx(row.rows[0].value, key) : cowFail('cow_presign_missing');
      if (old.revision !== record.revision || prepared.nonce !== old.nonce || prepared.from.toLowerCase() !== this.options.executor.toLowerCase()
        || prepared.chainId !== this.options.chainId || keccak256(prepared.raw) !== prepared.hash) cowFail('cow_transaction_identity_invalid');
      if (old.phase === 'clear-presign') {
        const originalKey = this.txKey(order.uid, 'presign'), original = await tx.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [originalKey]);
        const prior = original.rowCount ? this.decodeTx(original.rows[0].value, originalKey).attempts[0] : undefined;
        if (!prior || prepared.replaces !== prior.hash || prepared.nonce !== prior.nonce || prepared.to.toLowerCase() !== this.options.executor.toLowerCase()
          || prepared.data !== '0x' || prepared.value !== '0'
          || BigInt(prepared.maxFeePerGasWei) < (BigInt(prior.maxFeePerGasWei) * 9n + 7n) / 8n
          || BigInt(prepared.maxPriorityFeePerGasWei) < (BigInt(prior.maxPriorityFeePerGasWei) * 9n + 7n) / 8n) cowFail('cow_nonce_clearance_invalid');
      }
      if (old.attempts.length) {
        if (!isDeepStrictEqual(old.attempts[0], prepared)) cowFail('cow_prepared_identity_conflict');
        return old;
      }
      const value = { ...old, revision: old.revision + 1, attempts: [prepared] };
      await this.writeTx(tx, key, value); return value;
    });
  }
  async markBroadcast(lease: Lease, order: CowOrderRecord, record: CowTxRecord, txHash: Hex): Promise<void> {
    await this.options.transaction(async tx => {
      await this.fenced(tx, lease, order.decisionKey, order.intent);
      const stored = await tx.query<{ value: CowOrderRecord }>('SELECT value FROM app_settings WHERE key=$1 FOR UPDATE', [this.orderKey(order.clientOrderId)]);
      if (stored.rows[0]?.value.neverSubmitted) return cowFail('cow_order_never_submitted');
      const key = this.txKey(order.uid, record.phase), row = await tx.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1 FOR UPDATE', [key]);
      const old = row.rowCount ? this.decodeTx(row.rows[0].value, key) : cowFail('cow_presign_missing');
      if (!old.attempts.some(item => item.hash === txHash)) cowFail('cow_prepared_identity_conflict');
      if (!old.broadcastHashes.includes(txHash)) await this.writeTx(tx, key, { ...old, revision: old.revision + 1, broadcastHashes: [...old.broadcastHashes, txHash] });
    });
  }
}

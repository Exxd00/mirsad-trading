import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, query } from '../src/lib/db';
import { BrokerApiError, type RevolutOrder, type RevolutTransaction } from '../src/lib/brokers/revolut';
import { SqlJournal, initialState } from '../src/lib/execution/v1/journal';
import { CONFIG, type BuyIntent } from '../src/lib/execution/v1/model';
import { ConnectedRevolutVenue } from '../src/lib/execution/v1/revolut-venue';
import { syncSourceArchive } from '../src/lib/execution/v1/source-archive';
import { planBuy } from '../src/lib/execution/v1/planner';
import { evaluateRisk } from '../src/lib/execution/v1/risk';
import { NOW, account, instrument, quote, signal } from './execution-fixtures';

const atMs = NOW * 1000;
const sourceId = '61fe4f21-e83b-4168-8d1d-133c2220a509';
function intent() {
  const a = account();
  return planBuy(a, signal(), instrument(), quote(), evaluateRisk(initialState().risk, [], a.equityHistory, true, NOW), NOW).intent!;
}
function sourceOrder(i: BuyIntent, clientOrderId: string): RevolutOrder {
  return { id: sourceId, clientOrderId, accountId: 'revolut-x', symbol: i.symbol, side: 'buy', type: 'limit',
    quantity: i.quantity, filledQuantity: '0', status: 'new', price: i.limitPrice,
    createdAt: new Date(atMs).toISOString(), updatedAt: new Date(atMs).toISOString() };
}
function setup(journal: SqlJournal) {
  const client = { getBalances: vi.fn(async () => [
    { accountId: 'revolut-x' as const, currency: 'EUR', total: '100', available: '90', reserved: '10', observedAt: new Date(atMs).toISOString() },
    { accountId: 'revolut-x' as const, currency: 'AAA', total: '1', available: '0', reserved: '1', observedAt: new Date(atMs).toISOString() },
  ]), getOrders: vi.fn<() => Promise<RevolutOrder[]>>(async () => []), getOrder: vi.fn<() => Promise<RevolutOrder>>(),
  getTransactionsPage: vi.fn(async () => ({ transactions: [] as RevolutTransaction[], nextCursor: null as string | null, sourceAt: new Date(atMs).toISOString() })),
  submitOrder: vi.fn(), cancelOrder: vi.fn() };
  return { client, venue: new ConnectedRevolutVenue({ client, journal, instruments: async () => [], candles: async () => [],
    market: async () => { throw new Error('unused'); } }, () => NOW) };
}
const transaction = (): RevolutTransaction => ({ id: sourceId, accountId: 'revolut-x', type: 'receive', status: 'pending',
  createdAt: new Date(atMs - 1000).toISOString(), processedAt: null, orderId: null,
  source: { netAmount: '17.3200', currency: 'EUR', accountType: 'revolut', fee: null, feeCurrency: null },
  destination: { netAmount: '17.3200', currency: 'EUR', accountType: 'revolut_x', fee: null, feeCurrency: null } });

beforeEach(async () => {
  await closeDatabase(); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('VERCEL', ''); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://');
});
afterEach(async () => { await closeDatabase(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('source identity attached to the durable execution intent', () => {
  it('allocates a UUID once and retains it across duplicate begins, unknown results, and journal restarts', async () => {
    const j = new SqlJournal(), lease = (await j.acquire(CONFIG.accountId))!, i = intent();
    expect(await j.begin(lease, i, NOW)).toBe(true);
    const id = (await j.decision(lease, i.key))!.sourceIdentity!.clientOrderId;
    expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(await j.begin(lease, i, NOW + 1)).toBe(false);
    await j.result(lease, i.key, 'unknown', null); await j.release(lease);
    const restarted = new SqlJournal(), next = (await restarted.acquire(CONFIG.accountId))!;
    expect((await restarted.decision(next, i.key))?.sourceIdentity?.clientOrderId).toBe(id);
    await restarted.release(next);
  });

  it('distinguishes a never-allocated identity from an allocated but missing source order', async () => {
    const j = new SqlJournal(), lease = (await j.acquire(CONFIG.accountId))!, { client, venue } = setup(j), i = intent();
    expect(await venue.lookup(i.key, lease)).toEqual({ order: null, authoritative: true });
    expect(client.getOrders).not.toHaveBeenCalled();
    await j.begin(lease, i, NOW);
    expect(await venue.lookup(i.key, lease)).toEqual({ order: null, authoritative: false });
    expect(client.submitOrder).not.toHaveBeenCalled(); await j.release(lease);
  });

  it('never assigns a replacement UUID to an existing decision without source identity', async () => {
    const j = new SqlJournal(), lease = (await j.acquire(CONFIG.accountId))!, { client, venue } = setup(j), i = intent();
    await j.begin(lease, i, NOW);
    await query("UPDATE app_settings SET value=value-'sourceIdentity' WHERE key=$1", [`execution:v1:${CONFIG.accountId}:decision:${i.key}`]);
    expect(await venue.lookup(i.key, lease)).toEqual({ order: null, authoritative: false });
    expect((await j.decision(lease, i.key))?.sourceIdentity).toBeUndefined();
    expect(client.getOrders).not.toHaveBeenCalled(); await j.release(lease);
  });

  it('reconciles a late source acknowledgment using the saved UUID and then the source order ID', async () => {
    const j = new SqlJournal(), lease = (await j.acquire(CONFIG.accountId))!, { client, venue } = setup(j), i = intent();
    await j.begin(lease, i, NOW); await j.result(lease, i.key, 'unknown', null);
    const raw = sourceOrder(i, (await j.decision(lease, i.key))!.sourceIdentity!.clientOrderId);
    client.getOrders.mockResolvedValue([raw]); client.getOrder.mockResolvedValue(raw);
    const found = await venue.lookup(i.key, lease);
    expect(found).toMatchObject({ authoritative: true, order: { id: sourceId, clientKey: i.key, managed: true, purpose: 'entry' } });
    await j.result(lease, i.key, 'acknowledged', found.order);
    expect(await venue.lookup(i.key, lease)).toEqual(found);
    expect(client.getOrder).toHaveBeenCalledWith(sourceId);
    expect(client.getOrders).toHaveBeenCalledTimes(1);
    expect(client.submitOrder).not.toHaveBeenCalled(); await j.release(lease);
  });

  it.each(['symbol', 'side', 'quantity', 'price'])('refuses a source order that does not match the durable intent: %s', async field => {
    const j = new SqlJournal(), lease = (await j.acquire(CONFIG.accountId))!, { client, venue } = setup(j), i = intent();
    await j.begin(lease, i, NOW);
    const raw = sourceOrder(i, (await j.decision(lease, i.key))!.sourceIdentity!.clientOrderId);
    const mismatch: Record<string, string> = { symbol: 'OTHER-EUR', side: 'sell', quantity: '999', price: '999' };
    client.getOrders.mockResolvedValue([{ ...raw, [field]: mismatch[field] }]);
    await expect(venue.lookup(i.key, lease)).rejects.toThrow('source_order_identity_mismatch');
    expect(client.cancelOrder).not.toHaveBeenCalled(); await j.release(lease);
  });

  it('does not choose between duplicate source orders for the same client UUID', async () => {
    const j = new SqlJournal(), lease = (await j.acquire(CONFIG.accountId))!, { client, venue } = setup(j), i = intent();
    await j.begin(lease, i, NOW);
    const raw = sourceOrder(i, (await j.decision(lease, i.key))!.sourceIdentity!.clientOrderId);
    client.getOrders.mockResolvedValue([raw, { ...raw, id: 'ab9fbd19-b752-4371-9779-5f7e42ccb295' }]);
    await expect(venue.lookup(i.key, lease)).rejects.toThrow('source_identity_conflict'); await j.release(lease);
  });

  it('labels only known v1 orders while preserving pre-existing positions and protection', async () => {
    const j = new SqlJournal(), lease = (await j.acquire(CONFIG.accountId))!, { client, venue } = setup(j), i = intent();
    await j.begin(lease, i, NOW);
    const raw = sourceOrder(i, (await j.decision(lease, i.key))!.sourceIdentity!.clientOrderId);
    const previous: RevolutOrder = { ...raw, id: 'existing-protection', clientOrderId: 'owner-key', side: 'sell', type: 'tpsl', quantity: '1' };
    client.getOrders.mockResolvedValue([raw, previous]);
    const snapshot = await venue.account();
    expect(snapshot.orders[0]).toMatchObject({ clientKey: i.key, managed: true });
    expect(snapshot.orders[1]).toMatchObject({ id: 'existing-protection', managed: false, purpose: 'protection' });
    expect(snapshot.positions[0]).toMatchObject({ managed: false, quantity: '1', available: '0', reserved: '1', protectionIds: ['existing-protection'] });
    expect(snapshot).toMatchObject({ equityEur: null, valuationComplete: false, equityHistory: [], fills: null });
    expect(client.cancelOrder).not.toHaveBeenCalled(); await j.release(lease);
  });

  it('rejects stale and mismatched account leases before any source lookup', async () => {
    const j = new SqlJournal(), lease = (await j.acquire(CONFIG.accountId))!, { client, venue } = setup(j);
    await expect(venue.lookup('a'.repeat(64), { ...lease, key: 'execution:v1:different:lock' })).rejects.toThrow('source_lease_account_mismatch');
    await j.release(lease);
    await expect(venue.lookup('a'.repeat(64), lease)).rejects.toThrow('execution_lock_lost');
    expect(client.getOrders).not.toHaveBeenCalled();
  });
});

describe('source transactions on the existing monitoring cycle', () => {
  it('stores a real source page and its cursor atomically, deduplicating IDs without creating balances', async () => {
    const j = new SqlJournal(), lease = (await j.acquire(CONFIG.accountId))!, { client } = setup(j), record = transaction();
    client.getTransactionsPage.mockResolvedValueOnce({ transactions: [record, record], nextCursor: 'page-2', sourceAt: new Date(atMs).toISOString() });
    expect(await syncSourceArchive(client, j, lease, atMs)).toMatchObject({ status: 'source_read', records: 1, morePages: true, scannedUntilMs: null });
    expect(client.getTransactionsPage).toHaveBeenCalledWith({ startDate: atMs - 86_400_000, endDate: atMs, limit: 100 });
    const rows = await query<{ key: string; value: { record: RevolutTransaction } }>('SELECT key,value FROM app_settings WHERE key LIKE $1', [`execution:v1:${CONFIG.accountId}:source_transaction:%`]);
    expect(rows.rows).toHaveLength(1); expect(rows.rows[0].value.record).toEqual(record);
    expect(await j.sourceArchive(lease)).toMatchObject({ cursor: 'page-2', scannedUntilMs: null, lastError: null });
    await j.release(lease);
  });

  it('resumes pagination after a journal restart and does not silently accept a looping cursor', async () => {
    const j = new SqlJournal(), lease = (await j.acquire(CONFIG.accountId))!, { client } = setup(j);
    client.getTransactionsPage.mockResolvedValue({ transactions: [], nextCursor: 'a', sourceAt: new Date(atMs).toISOString() });
    await syncSourceArchive(client, j, lease, atMs); await j.release(lease);
    const restarted = new SqlJournal(), next = (await restarted.acquire(CONFIG.accountId))!;
    client.getTransactionsPage.mockResolvedValueOnce({ transactions: [], nextCursor: 'b', sourceAt: new Date(atMs).toISOString() });
    await syncSourceArchive(client, restarted, next, atMs + 1000);
    expect(client.getTransactionsPage).toHaveBeenLastCalledWith({ startDate: atMs - 86_400_000, endDate: atMs, cursor: 'a', limit: 100 });
    expect(await syncSourceArchive(client, restarted, next, atMs + 2000)).toMatchObject({ status: 'unavailable', reason: 'source_archive_cursor_repeated' });
    expect(await restarted.sourceArchive(next)).toMatchObject({ cursor: 'b', scannedUntilMs: null }); await restarted.release(next);
  });

  it('preserves committed archive progress when the source fails, then retries the same page', async () => {
    const j = new SqlJournal(), lease = (await j.acquire(CONFIG.accountId))!, { client } = setup(j);
    client.getTransactionsPage.mockResolvedValueOnce({ transactions: [transaction()], nextCursor: 'next', sourceAt: new Date(atMs).toISOString() });
    await syncSourceArchive(client, j, lease, atMs);
    client.getTransactionsPage.mockRejectedValueOnce(new BrokerApiError('private error detail', { code: 'RATE_LIMIT', retryAfterMs: 1000 }));
    expect(await syncSourceArchive(client, j, lease, atMs + 1000)).toEqual({ status: 'unavailable', reason: 'RATE_LIMIT' });
    expect(await j.sourceArchive(lease)).toMatchObject({ cursor: 'next', lastReadAtMs: atMs, lastError: 'RATE_LIMIT' });
    await syncSourceArchive(client, j, lease, atMs + 2000);
    expect(client.getTransactionsPage).toHaveBeenLastCalledWith({ startDate: atMs - 86_400_000, endDate: atMs, cursor: 'next', limit: 100 });
    expect(await j.sourceArchive(lease)).toMatchObject({ cursor: null, scannedUntilMs: atMs, lastError: null }); await j.release(lease);
  });

  it('overlaps recent reads and bounds backlog windows without claiming an equity history', async () => {
    const j = new SqlJournal(), lease = (await j.acquire(CONFIG.accountId))!, { client, venue } = setup(j);
    await syncSourceArchive(client, j, lease, atMs);
    expect(await syncSourceArchive(client, j, lease, atMs)).toMatchObject({ status: 'not_due' });
    const later = atMs + 2 * 86_400_000;
    client.getTransactionsPage.mockResolvedValueOnce({ transactions: [], nextCursor: null, sourceAt: new Date(later).toISOString() });
    await syncSourceArchive(client, j, lease, later);
    expect(client.getTransactionsPage).toHaveBeenLastCalledWith({ startDate: atMs - 300_000, endDate: atMs - 300_000 + 86_400_000, limit: 100 });
    expect(await venue.account()).toMatchObject({ equityHistory: [], tradeHistoryComplete: false, archiveStart: null }); await j.release(lease);
  });

  it('does not advance archive progress on conflicting transaction rows', async () => {
    const j = new SqlJournal(), lease = (await j.acquire(CONFIG.accountId))!, { client } = setup(j), record = transaction();
    client.getTransactionsPage.mockResolvedValueOnce({ transactions: [record, { ...record, status: 'completed' }], nextCursor: 'next', sourceAt: new Date(atMs).toISOString() });
    expect(await syncSourceArchive(client, j, lease, atMs)).toMatchObject({ status: 'unavailable', reason: 'source_archive_transaction_conflict' });
    expect(await j.sourceArchive(lease)).toMatchObject({ cursor: null, lastReadAtMs: null, scannedUntilMs: null });
    const rows = await query('SELECT key FROM app_settings WHERE key LIKE $1', [`execution:v1:${CONFIG.accountId}:source_transaction:%`]);
    expect(rows.rows).toHaveLength(0); await j.release(lease);
  });

  it('loses write authority after lease expiry during a source read', async () => {
    const j = new SqlJournal(), lease = (await j.acquire(CONFIG.accountId))!, { client } = setup(j);
    client.getTransactionsPage.mockImplementationOnce(async () => {
      await query("UPDATE app_settings SET value=jsonb_set(value,'{expires}','0'::jsonb) WHERE key=$1", [lease.key]);
      return { transactions: [transaction()], nextCursor: 'next', sourceAt: new Date(atMs).toISOString() };
    });
    await expect(syncSourceArchive(client, j, lease, atMs)).rejects.toThrow('execution_lock_lost');
    const rows = await query('SELECT key FROM app_settings WHERE key LIKE $1', [`execution:v1:${CONFIG.accountId}:source_%`]);
    expect(rows.rows).toHaveLength(0);
  });

  it('keeps transaction archive work out of deadline reconciliation and leaves source writes disabled', async () => {
    const j = new SqlJournal(), lease = (await j.acquire(CONFIG.accountId))!, { client, venue } = setup(j);
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await venue.reconcile(lease); expect(client.getTransactionsPage).not.toHaveBeenCalled();
    await venue.reconcile(lease, { transactions: true }); expect(client.getTransactionsPage).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({ type: 'execution.v1.source_archive', status: 'source_read', records: 0, morePages: false, scannedUntilMs: atMs });
    expect(await venue.capabilities()).toMatchObject({ attachedProtection: false, fencedWrites: true, idempotentOrders: true, entryRiskData: false });
    await expect(venue.submit()).rejects.toThrow('execution_not_armed');
    expect(client.submitOrder).not.toHaveBeenCalled(); expect(client.cancelOrder).not.toHaveBeenCalled(); await j.release(lease);
  });
});

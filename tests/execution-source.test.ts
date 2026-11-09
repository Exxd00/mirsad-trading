import { testWalletSource, testWalletIdentity, testWalletCosts } from './execution-fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, query } from '../src/lib/db';
import { SourceApiError, type ReportedOrder, type SourceTransaction } from '../src/lib/execution/v1/source-model';
import { SqlJournal, initialState } from '../src/lib/execution/v1/journal';
import { CONFIG, decimal, type BuyIntent } from '../src/lib/execution/v1/model';
import { ConnectedWalletVenue, type WalletVenueSource } from '../src/lib/execution/v1/wallet-venue';
import { syncSourceArchive } from '../src/lib/execution/v1/source-archive';
import { refreshSourceAccounting } from '../src/lib/execution/v1/account-evidence';
import { installWalletExecutionSource } from '../src/lib/wallet/execution-connection';
import { saveOwnerManualWatchlist, saveOwnerStrategySelection, strategyEntrySelection } from '../src/lib/wallet/selection-service';
import { STRATEGY_SELECTION_KEY } from '../src/lib/wallet/strategy-selection';
import type { ReportedFill } from '../src/lib/execution/v1/source-model';
import { planBuy } from '../src/lib/execution/v1/planner';
import { evaluateRisk } from '../src/lib/execution/v1/risk';
import { NOW, account, instrument, quote, signal } from './execution-fixtures';

const atMs = NOW * 1000;
const sourceId = '61fe4f21-e83b-4168-8d1d-133c2220a509';
function intent() {
  const a = account();
  return planBuy(a, signal(), instrument(), quote(), evaluateRisk(initialState().risk, [], a.equityHistory, true, NOW), NOW).intent!;
}
function sourceOrder(i: BuyIntent, clientOrderId: string): ReportedOrder {
  return { id: sourceId, clientOrderId, accountId: 'metamask-strategy-v1', symbol: i.symbol, side: 'buy', type: 'limit',
    quantity: i.quantity, filledQuantity: '0', status: 'new', price: i.limitPrice,
    createdAt: new Date(atMs).toISOString(), updatedAt: new Date(atMs).toISOString() };
}
function setup(journal: SqlJournal) {
  const client = { getBalances: vi.fn(async () => [
    { accountId: 'metamask-strategy-v1' as const, currency: 'EUR', total: '100', available: '90', reserved: '10', observedAt: new Date(atMs).toISOString() },
    { accountId: 'metamask-strategy-v1' as const, currency: 'AAA', total: '1', available: '0', reserved: '1', observedAt: new Date(atMs).toISOString() },
  ]), getOrders: vi.fn<() => Promise<ReportedOrder[]>>(async () => []), getOrder: vi.fn<() => Promise<ReportedOrder>>(),
  getTransactionsPage: vi.fn(async () => ({ transactions: [] as SourceTransaction[], nextCursor: null as string | null, sourceAt: new Date(atMs).toISOString() })),
  getFillsForOrders: vi.fn(async () => ({ fills: [] as ReportedFill[], truncated: false })),
  submitOrder: vi.fn(), cancelOrder: vi.fn() };
  const source = { ...testWalletSource(), client, journal, instruments: async () => [], candles: async () => [],
    market: async () => { throw new Error('unused'); } };
  return { client, source, venue: new ConnectedWalletVenue(source, () => NOW) };
}
const transaction = (): SourceTransaction => ({ id: sourceId, accountId: 'metamask-strategy-v1', type: 'receive', status: 'pending',
  createdAt: new Date(atMs - 1000).toISOString(), processedAt: null, orderId: null,
  source: { netAmount: '17.3200', currency: 'EUR', accountType: 'external', fee: null, feeCurrency: null },
  destination: { netAmount: '17.3200', currency: 'EUR', accountType: 'wallet', fee: null, feeCurrency: null } });

beforeEach(async () => {
  await closeDatabase(); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('VERCEL', ''); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://');
});
afterEach(async () => { installWalletExecutionSource(null); await closeDatabase(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function authorizedBuy(journal: SqlJournal) {
  vi.stubEnv('MIRSAD_ORDER_CONNECTION', 'metamask');
  vi.stubEnv('EXECUTION_DEADLINE_URL', 'https://isolated-timer.invalid/schedule');
  vi.stubEnv('EXECUTION_SCHEDULER_TOKEN', 'isolated-scheduler-only');
  const timer = vi.fn(async (input: string | URL | Request) => {
    if (String(input) !== 'https://isolated-timer.invalid/watch-protection') throw new Error('Unexpected isolated scheduler route');
    return Response.json({ scheduled: true, mode: 'mirsad', intervalSeconds: 10 });
  });
  vi.stubGlobal('fetch', timer);
  const base = setup(journal), client = { ...base.client,
    getBalances: vi.fn(async () => [{ accountId: CONFIG.accountId as 'metamask-strategy-v1', currency: 'EUR',
      total: '1000', available: '1000', reserved: '0', observedAt: new Date(atMs).toISOString() }]),
    getTransaction: vi.fn(async () => { throw new Error('No source transactions exist in the isolated fixture'); }),
    getValuationCandles: vi.fn(async () => []),
    getOrderBook: vi.fn(async (symbol: string) => ({ symbol, sourceAt: atMs, readAt: atMs,
      bids: [{ price: '99.99', quantity: '10' }], asks: [{ price: '100', quantity: '10' }] })),
    submitOrder: vi.fn(async (input: { clientOrderId: string; symbol: string; quantity: string; limitPrice?: string }): Promise<ReportedOrder> => ({
      id: sourceId, accountId: 'metamask-strategy-v1', clientOrderId: input.clientOrderId, symbol: input.symbol,
      side: 'buy', type: 'limit', quantity: input.quantity, filledQuantity: '0', price: input.limitPrice, status: 'new',
      createdAt: new Date(atMs).toISOString(), updatedAt: new Date(atMs).toISOString() })),
  };
  const source = { ...base.source, client, instruments: async () => [{ symbol: 'AAA-EUR', base: 'AAA', quote: 'EUR',
    baseStep: '0.001', quoteStep: '0.01', minOrderSize: '0.001', minOrderSizeQuote: '1', maxOrderSize: '100',
    status: 'active' as const, region: 'EEA', observedAt: new Date(atMs).toISOString(), costs: testWalletCosts() }] };
  installWalletExecutionSource(source);
  await saveOwnerStrategySelection('opportunities', null);
  const prefetched = await strategyEntrySelection(() => NOW);
  expect(prefetched).toMatchObject({ mode: 'opportunities', symbols: ['AAA-EUR', 'ETH-EUR', 'SOL-EUR'], reason: null });
  await refreshSourceAccounting(client, journal, () => NOW);
  const venue = new ConnectedWalletVenue(source, () => NOW), snapshot = await venue.account();
  expect(snapshot.dataBlockers).toEqual([]); expect(snapshot.tradeHistoryComplete).toBe(true);
  const i = (await venue.instruments())[0], q = (await venue.quotes(['AAA-EUR']))[0];
  const planned = planBuy(snapshot, signal(), i, q, evaluateRisk(initialState().risk, [], snapshot.equityHistory, true, NOW), NOW).intent;
  if (!planned) throw new Error('Expected a fully eligible isolated buy');
  const lease = (await journal.acquire(CONFIG.accountId))!;
  await journal.save(lease, { ...initialState(), entriesEnabled: true, executionArmed: true, walletIdentity: testWalletIdentity() });
  await journal.saveProtectionHeartbeat(lease, { at: NOW, status: 'idle', managedPositions: 0, checkedPositions: 0, errors: [] });
  await journal.begin(lease, planned, NOW);
  return { client, source, venue, lease, planned, prefetched, timer };
}

describe('current owner opportunity selection immediately before the financial write', () => {
  it('blocks a newly expensive executable-size quote before making the durable financial write claim', async () => {
    const j = new SqlJournal(), current = await authorizedBuy(j), source: WalletVenueSource = current.source;
    source.entryPlan = vi.fn(async () => ({ intent: null, reason: 'round_trip_cost_limit' }));
    await expect(current.venue.submit(current.planned, current.lease)).rejects.toThrow('round_trip_cost_limit');
    expect(source.entryPlan).toHaveBeenCalledOnce(); expect(current.client.submitOrder).not.toHaveBeenCalled();
    expect(await j.sourceWrites(current.lease)).toEqual([]);
    expect(await j.decision(current.lease, current.planned.key)).toMatchObject({ status: 'absent' });
    await j.release(current.lease);
  });
  it('allows one explicitly authorized opportunity buy through real accounting, risk, heartbeat and lease guards', async () => {
    const j = new SqlJournal(), current = await authorizedBuy(j);
    expect(current.planned).toMatchObject({ allocation: '0.10', budgetEur: '100', expiresAt: NOW + 60 });
    expect(await current.venue.submit(current.planned, current.lease)).toMatchObject({ status: 'open', id: sourceId, clientKey: current.planned.key });
    await expect(current.venue.submit(current.planned, current.lease)).rejects.toThrow('source_write_already_attempted');
    expect(current.client.submitOrder).toHaveBeenCalledOnce(); expect(current.timer).toHaveBeenCalledOnce();
    expect(await j.sourceWrites(current.lease)).toEqual([expect.objectContaining({ kind: 'submit', settledAt: NOW })]);
    await j.release(current.lease);
  });
  it('rejects a prefetched opportunity after the owner narrows selection before the new account lease', async () => {
    const j = new SqlJournal(), current = await authorizedBuy(j);
    expect(current.prefetched.symbols).toContain(current.planned.symbol); await j.release(current.lease);
    await saveOwnerManualWatchlist(['ETH-EUR']); await saveOwnerStrategySelection('manual', 1);
    const lease = (await j.acquire(CONFIG.accountId))!;
    await expect(current.venue.submit(current.planned, lease)).rejects.toThrow('wallet_strategy_selection_changed');
    expect(current.client.submitOrder).not.toHaveBeenCalled(); expect(current.timer).not.toHaveBeenCalled();
    expect(await j.sourceWrites(lease)).toEqual([]); expect(await j.decision(lease, current.planned.key)).toMatchObject({ status: 'absent' });
    // The runner's conservative catch must retain this proven pre-send absence.
    await j.result(lease, current.planned.key, 'unknown', null);
    expect(await j.decision(lease, current.planned.key)).toMatchObject({ status: 'absent' });
    expect(await current.venue.lookup(current.planned.key, lease)).toEqual({ order: null, authoritative: true });
    await j.release(lease);
  });
  it('rejects corrupt selection mode before creating a provider write claim', async () => {
    const j = new SqlJournal(), current = await authorizedBuy(j); await j.release(current.lease);
    await query("UPDATE app_settings SET value=jsonb_set(value,'{policy,mode}',to_jsonb('untrusted-mode'::text)) WHERE key=$1", [STRATEGY_SELECTION_KEY]);
    const lease = (await j.acquire(CONFIG.accountId))!;
    await expect(current.venue.submit(current.planned, lease)).rejects.toThrow('wallet_strategy_selection_invalid');
    expect(current.client.submitOrder).not.toHaveBeenCalled(); expect(await j.sourceWrites(lease)).toEqual([]); await j.release(lease);
  });
  it('does not substitute the venue snapshot for a currently installed and verified opportunity source', async () => {
    const j = new SqlJournal(), current = await authorizedBuy(j); installWalletExecutionSource(null);
    await expect(current.venue.submit(current.planned, current.lease)).rejects.toThrow('wallet_opportunity_universe_unavailable');
    expect(current.client.submitOrder).not.toHaveBeenCalled(); expect(await j.sourceWrites(current.lease)).toEqual([]); await j.release(current.lease);
  });
  it('preserves the actual stale-protection error once the opportunity selection is genuinely authorized', async () => {
    const j = new SqlJournal(), current = await authorizedBuy(j);
    await j.saveProtectionHeartbeat(current.lease, { at: NOW - CONFIG.protectionHeartbeatMaxAgeSeconds - 1,
      status: 'idle', managedPositions: 0, checkedPositions: 0, errors: [] });
    await expect(current.venue.submit(current.planned, current.lease)).rejects.toThrow('protection_monitor_stale');
    expect(current.client.submitOrder).not.toHaveBeenCalled(); expect(await j.sourceWrites(current.lease)).toEqual([]); await j.release(current.lease);
  });
});

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
    const previous: ReportedOrder = { ...raw, id: 'existing-protection', clientOrderId: 'owner-key', side: 'sell', type: 'tpsl', quantity: '1' };
    client.getOrders.mockResolvedValue([raw, previous]);
    const snapshot = await venue.account();
    expect(snapshot.orders[0]).toMatchObject({ clientKey: i.key, managed: true });
    expect(snapshot.orders[1]).toMatchObject({ id: 'existing-protection', managed: false, purpose: 'protection' });
    expect(snapshot.positions[0]).toMatchObject({ managed: false, quantity: '1', available: '0', reserved: '1', protectionIds: ['existing-protection'] });
    expect(snapshot).toMatchObject({ equityEur: null, valuationComplete: false, equityHistory: [], fills: [] });
    expect(client.cancelOrder).not.toHaveBeenCalled(); await j.release(lease);
  });

  it('rejects stale and mismatched account leases before any source lookup', async () => {
    const j = new SqlJournal(), lease = (await j.acquire(CONFIG.accountId))!, { client, venue } = setup(j);
    await expect(venue.lookup('a'.repeat(64), { ...lease, key: 'execution:v1:different:lock' })).rejects.toThrow('source_lease_account_mismatch');
    await j.release(lease);
    await expect(venue.lookup('a'.repeat(64), lease)).rejects.toThrow('execution_lock_lost');
    expect(client.getOrders).not.toHaveBeenCalled();
  });
  it('uses authoritative details for engine and report when summaries omit base fees, without rewriting the journal', async () => {
    const j = new SqlJournal(), lease = (await j.acquire(CONFIG.accountId))!, { client, venue } = setup(j), i = intent();
    await j.begin(lease, i, NOW);
    const raw: ReportedOrder = { ...sourceOrder(i, (await j.decision(lease, i.key))!.sourceIdentity!.clientOrderId),
      status: 'filled', filledQuantity: i.quantity, averageFillPrice: '100', fee: '0.0001', feeCurrency: 'AAA' };
    const summary = { ...raw, fee: undefined, feeCurrency: undefined, averageFillPrice: '99' };
    client.getOrders.mockResolvedValue([summary]); client.getOrder.mockResolvedValue(raw);
    client.getFillsForOrders.mockResolvedValue({ truncated: false, fills: [{ id: 'fresh-fill', orderId: raw.id,
      accountId: 'metamask-strategy-v1', symbol: raw.symbol, side: raw.side, quantity: raw.filledQuantity, price: '100',
      baseCurrency: 'AAA', quoteCurrency: 'EUR', createdAt: raw.createdAt, maker: false }] });
    await venue.lookup(i.key, lease);
    const quantity = decimal(i.quantity).sub('0.0001').toFixed();
    await j.saveProtection(lease, { entryKey: i.key, entryOrderId: raw.id, symbol: raw.symbol,
      quantity, entryFilled: i.quantity, exitedQuantity: '0.0001', averageFillPrice: '100', stop: '98', originalStop: '98', target: '104',
      sourceAt: NOW, updatedAt: NOW, status: 'watching', trigger: null, lastError: null });
    await j.release(lease);
    const before = await j.accountDecisions(CONFIG.accountId), protection = await j.protections(CONFIG.accountId);
    const live = await venue.account();
    const report = await venue.reportAccount();
    expect(live).toEqual(report);
    expect(report.positions.find(p => p.managed)).toMatchObject({ quantity, averageFillPrice: '100' });
    expect(report.orders[0]).toMatchObject({ baseFeeQuantity: '0.0001', feeEur: '0.01', averageFillPrice: '100' });
    expect(report.reportEvidence?.status).toBe('matched');
    expect(report.fills?.[0].price).toBe('100');
    client.getOrders.mockResolvedValueOnce([]);
    expect((await venue.account()).positions.find(p => p.managed)).toMatchObject({ quantity, averageFillPrice: '100' });
    client.getFillsForOrders.mockRejectedValueOnce(new Error('sensitive provider failure'));
    const unavailable = await venue.reportAccount();
    expect(unavailable).toMatchObject({ fills: null, tradeHistoryComplete: false,
      reportEvidence: { status: 'unavailable', issues: ['report_fills_unavailable'] } });
    expect(unavailable.orders[0].feeEur).toBeNull();
    expect(await j.accountDecisions(CONFIG.accountId)).toEqual(before);
    expect(await j.protections(CONFIG.accountId)).toEqual(protection);
    expect(client.submitOrder).not.toHaveBeenCalled(); expect(client.cancelOrder).not.toHaveBeenCalled();
    // Missing fee evidence in full details is still a real quantity regression.
    client.getOrder.mockResolvedValueOnce(summary);
    await expect(venue.account()).rejects.toThrow('managed_exit_fill_mismatch');
    client.getOrder.mockResolvedValueOnce({ ...raw, id: 'different-source-id' });
    await expect(venue.reportAccount()).rejects.toThrow('source_order_identity_mismatch');
    client.getOrder.mockRejectedValueOnce(new Error('unavailable'));
    await expect(venue.account()).rejects.toThrow('unavailable');
    // A fresh but contradictory fill must block the actual entry planner, too.
    client.getFillsForOrders.mockResolvedValueOnce({ truncated: false, fills: [{ id: 'conflicting-fill', orderId: raw.id,
      accountId: 'metamask-strategy-v1', symbol: raw.symbol, side: 'buy', quantity: raw.filledQuantity, price: '98',
      baseCurrency: 'AAA', quoteCurrency: 'EUR', createdAt: raw.createdAt, maker: false }] });
    const conflict = await venue.account();
    expect(conflict).toMatchObject({ reportEvidence: { status: 'conflict' },
      dataBlockers: ['report_fill_price_mismatch'], tradeHistoryComplete: false });
    const ready = account();
    expect(planBuy({ ...ready, dataBlockers: conflict.dataBlockers }, signal(), instrument(), quote(),
      evaluateRisk(initialState().risk, [], ready.equityHistory, true, NOW), NOW))
      .toMatchObject({ intent: null, reason: 'report_fill_price_mismatch' });
    expect(await j.accountDecisions(CONFIG.accountId)).toEqual(before);
    expect(await j.protections(CONFIG.accountId)).toEqual(protection);
    expect(client.submitOrder).not.toHaveBeenCalled(); expect(client.cancelOrder).not.toHaveBeenCalled();
  });
});

describe('source transactions on the existing monitoring cycle', () => {
  it('stores a real source page and its cursor atomically, deduplicating IDs without creating balances', async () => {
    const j = new SqlJournal(), lease = (await j.acquire(CONFIG.accountId))!, { client } = setup(j), record = transaction();
    client.getTransactionsPage.mockResolvedValueOnce({ transactions: [record, record], nextCursor: 'page-2', sourceAt: new Date(atMs).toISOString() });
    expect(await syncSourceArchive(client, j, lease, atMs)).toMatchObject({ status: 'source_read', records: 1, morePages: true, scannedUntilMs: null });
    expect(client.getTransactionsPage).toHaveBeenCalledWith({ startDate: atMs - 86_400_000, endDate: atMs, limit: 100 });
    const rows = await query<{ key: string; value: { record: SourceTransaction } }>('SELECT key,value FROM app_settings WHERE key LIKE $1', [`execution:v1:${CONFIG.accountId}:source_transaction:%`]);
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
    client.getTransactionsPage.mockRejectedValueOnce(new SourceApiError('private error detail', { code: 'RATE_LIMIT', retryAfterMs: 1000 }));
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


import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, query } from '../src/lib/db';
import { BrokerUnknownOutcomeError, type RevolutBalance, type RevolutMarket, type RevolutOrder, type RevolutSubmitOrder } from '../src/lib/brokers/revolut';
import { SqlJournal, initialState } from '../src/lib/execution/v1/journal';
import { CONFIG, D, terminal, type SellIntent } from '../src/lib/execution/v1/model';
import { ConnectedRevolutVenue } from '../src/lib/execution/v1/revolut-venue';
import { protectionCycle } from '../src/lib/execution/v1/managed-protection';
import { planBuy, planExit } from '../src/lib/execution/v1/planner';
import { evaluateRisk } from '../src/lib/execution/v1/risk';
import { scheduleProtectionWatch } from '../src/lib/execution/v1/scheduler';
import { NOW, account, instrument, quote, signal } from './execution-fixtures';
import worker, { OrderDeadline } from '../automation/execution-v1-worker.mjs';

beforeEach(async () => {
  await closeDatabase(); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('VERCEL', ''); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://');
  vi.stubEnv('EXECUTION_DEADLINE_URL', 'https://worker.test/schedule'); vi.stubEnv('EXECUTION_SCHEDULER_TOKEN', 'test');
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(async () => { await closeDatabase(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function setup(options: { armed?: boolean; fill?: string; entryStatus?: RevolutOrder['status']; bid?: string } = {}) {
  const journal = new SqlJournal(), lease = (await journal.acquire(CONFIG.accountId))!;
  const state = initialState(); state.executionArmed = options.armed ?? true;
  // Source fixtures are isolated in an in-memory test DB. No account API or
  // financial mutation is ever contacted by these tests.
  await journal.save(lease, state);
  const a = account();
  const buy = { ...planBuy(a, signal(), instrument(), quote(), evaluateRisk(state.risk, [], a.equityHistory, true, NOW), NOW).intent!, quantity: '1' };
  await journal.begin(lease, buy, NOW);
  const record = (await journal.decision(lease, buy.key))!;
  const entry: RevolutOrder = { id: randomUUID(), clientOrderId: record.sourceIdentity!.clientOrderId, accountId: 'revolut-x',
    symbol: buy.symbol, side: 'buy', type: 'limit', quantity: '1', filledQuantity: options.fill ?? '1',
    status: options.entryStatus ?? 'filled', price: buy.limitPrice, averageFillPrice: '100',
    createdAt: new Date((NOW - 100) * 1000).toISOString(), updatedAt: new Date(NOW * 1000).toISOString() };
  const orders = new Map<string, RevolutOrder>([[entry.id, entry]]);
  const market = { bid: options.bid ?? '99', sourceAt: NOW, extraBalance: '0', reserved: '0' };
  const client = {
    getOrders: vi.fn(async () => structuredClone([...orders.values()])),
    getActiveOrders: vi.fn(async () => structuredClone([...orders.values()].filter(o => !['filled', 'cancelled', 'rejected'].includes(o.status)))),
    getOrder: vi.fn(async (id: string) => { const o = orders.get(id); if (!o) throw new Error('source_not_found'); return structuredClone(o); }),
    getBalances: vi.fn(async (): Promise<RevolutBalance[]> => {
      const sold = [...orders.values()].filter(o => o.side === 'sell' && o.type === 'market').reduce((sum, o) => sum.add(o.filledQuantity), new D(0));
      const total = new D(entry.filledQuantity).sub(sold).add(market.extraBalance);
      return [{ accountId: 'revolut-x', currency: 'EUR', total: '100', available: '100', reserved: '0', observedAt: new Date(NOW * 1000).toISOString() },
        { accountId: 'revolut-x', currency: 'AAA', total: total.toFixed(), available: total.sub(market.reserved).toFixed(), reserved: market.reserved, observedAt: new Date(NOW * 1000).toISOString() }];
    }),
    submitOrder: vi.fn(async (input: RevolutSubmitOrder): Promise<RevolutOrder> => {
      const o: RevolutOrder = { ...entry, id: randomUUID(), clientOrderId: input.clientOrderId, side: input.side,
        type: input.type, quantity: input.quantity, filledQuantity: input.quantity, status: 'filled', averageFillPrice: market.bid };
      orders.set(o.id, o); return structuredClone(o);
    }),
    cancelOrder: vi.fn(async (id: string) => {
      const o = orders.get(id)!; o.status = 'cancelled';
      return { order: structuredClone(o), cancellationAcknowledged: true, settled: true };
    }),
  };
  const source = { client, journal, instruments: async () => [{ symbol: 'AAA-EUR', base: 'AAA', quote: 'EUR', baseStep: '0.001', quoteStep: '0.01',
    minOrderSize: '0.001', maxOrderSize: '1000', minOrderSizeQuote: '1', status: 'active' as const, region: 'EEA' as const, observedAt: new Date(NOW * 1000).toISOString() }],
    candles: vi.fn(async () => []), market: vi.fn(async (): Promise<RevolutMarket> => ({ symbol: 'AAA-EUR', region: 'EEA', source: 'Revolut X',
      bid: market.bid, ask: new D(market.bid).add('0.01').toFixed(), last: market.bid, mid: market.bid, low24h: market.bid, high24h: market.bid,
      change24h: '0', volume24h: '0', quoteVolume24h: '0', interval: 15, sourceTimestamp: market.sourceAt * 1000,
      candleSourceTimestamp: market.sourceAt * 1000, observedAt: new Date(NOW * 1000).toISOString(), candles: [] })) };
  const venue = new ConnectedRevolutVenue(source, () => NOW);
  await venue.lookup(buy.key, lease); await journal.release(lease);
  return { journal, venue, source, client, entry, buy, orders, market };
}

describe('server-managed protection from actual source fills', () => {
  it('persists partial-fill levels without requiring native TP/SL or an open browser', async () => {
    const s = await setup({ fill: '0.4', entryStatus: 'partially_filled' });
    expect(await protectionCycle(s.venue, s.journal, () => NOW)).toMatchObject({ status: 'watching', managedPositions: 1, checkedPositions: 1 });
    expect(await s.journal.protections(CONFIG.accountId)).toEqual([expect.objectContaining({ quantity: '0.4', stop: '98', target: '104', originalStop: '98', status: 'watching' })]);
    expect(s.client.submitOrder).not.toHaveBeenCalled(); expect(s.source.candles).not.toHaveBeenCalled();
    s.entry.filledQuantity = '0.8'; s.entry.averageFillPrice = '99';
    await protectionCycle(s.venue, new SqlJournal(), () => NOW);
    expect(await s.journal.protections(CONFIG.accountId)).toEqual([expect.objectContaining({ quantity: '0.8', stop: '98', target: '102.96', originalStop: '98' })]);
  });
  it.each([['97', 'stop'], ['104', 'target']])('exits on bid %s with one persistent %s decision while entries are paused', async (bid, reason) => {
    const s = await setup({ bid });
    expect(await protectionCycle(s.venue, s.journal, () => NOW)).toMatchObject({ status: 'watching', errors: [] });
    expect(s.client.submitOrder).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ side: 'sell', type: 'market', quantity: '1' }));
    const decisions = await s.journal.accountDecisions(CONFIG.accountId);
    expect(decisions.find(d => d.intent.side === 'sell')?.intent).toMatchObject({ reason, reduceOnly: true });
    await protectionCycle(new ConnectedRevolutVenue(s.source, () => NOW), new SqlJournal(), () => NOW);
    expect(s.client.submitOrder).toHaveBeenCalledTimes(1);
    expect((await s.journal.protections(CONFIG.accountId))[0]).toMatchObject({ status: 'closed', quantity: '0' });
  });
  it('cancels only its own unfilled entry before selling the confirmed partial quantity', async () => {
    const s = await setup({ bid: '97', fill: '0.4', entryStatus: 'partially_filled' });
    await protectionCycle(s.venue, s.journal, () => NOW);
    expect(s.client.cancelOrder).toHaveBeenCalledExactlyOnceWith(s.entry.id);
    expect(s.client.submitOrder).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ quantity: '0.4', side: 'sell' }));
    expect(s.client.cancelOrder.mock.invocationCallOrder[0]).toBeLessThan(s.client.submitOrder.mock.invocationCallOrder[0]);
  });
  it('preserves a stop trigger through unknown cancellation, a restart and a price rebound', async () => {
    const s = await setup({ bid: '97', fill: '0.4', entryStatus: 'partially_filled' });
    s.client.cancelOrder.mockRejectedValueOnce(new Error('transport_unknown'));
    expect(await protectionCycle(s.venue, s.journal, () => NOW)).toMatchObject({ status: 'blocked' });
    expect(s.client.submitOrder).not.toHaveBeenCalled();
    s.market.bid = '101';
    await protectionCycle(new ConnectedRevolutVenue(s.source, () => NOW), new SqlJournal(), () => NOW);
    expect(s.client.cancelOrder).toHaveBeenCalledTimes(1); expect(s.client.submitOrder).not.toHaveBeenCalled();
    s.entry.status = 'cancelled';
    await protectionCycle(s.venue, s.journal, () => NOW);
    expect(s.client.submitOrder).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ quantity: '0.4' }));
    expect((await s.journal.protections(CONFIG.accountId))[0].trigger?.reason).toBe('stop');
  });
  it('never repeats an uncertain sell and reconciles a late source acknowledgment', async () => {
    const s = await setup({ bid: '97' }); let late: RevolutOrder | undefined;
    s.client.submitOrder.mockImplementationOnce(async input => {
      late = { ...s.entry, id: randomUUID(), clientOrderId: input.clientOrderId, side: 'sell', type: 'market', quantity: input.quantity, filledQuantity: input.quantity, status: 'filled' };
      throw new BrokerUnknownOutcomeError(input.clientOrderId, late.id, true);
    });
    expect(await protectionCycle(s.venue, s.journal, () => NOW)).toMatchObject({ status: 'blocked' });
    const sell = (await s.journal.accountDecisions(CONFIG.accountId)).find(d => d.intent.side === 'sell')!;
    expect(sell.sourceIdentity?.venueOrderId).toBe(late!.id);
    await protectionCycle(s.venue, new SqlJournal(), () => NOW);
    expect(s.client.submitOrder).toHaveBeenCalledTimes(1);
    s.orders.set(late!.id, late!);
    await protectionCycle(new ConnectedRevolutVenue(s.source, () => NOW), new SqlJournal(), () => NOW);
    expect(s.client.submitOrder).toHaveBeenCalledTimes(1);
    expect((await s.journal.protections(CONFIG.accountId))[0].status).toBe('closed');
  });
  it('does not sell a remainder until the first exit is confirmed terminal', async () => {
    const s = await setup({ bid: '97' });
    s.client.submitOrder.mockImplementationOnce(async input => {
      const o: RevolutOrder = { ...s.entry, id: randomUUID(), clientOrderId: input.clientOrderId, side: 'sell', type: 'market', quantity: input.quantity, filledQuantity: '0.4', status: 'partially_filled' };
      s.orders.set(o.id, o); return structuredClone(o);
    });
    await protectionCycle(s.venue, s.journal, () => NOW);
    await protectionCycle(s.venue, s.journal, () => NOW);
    expect(s.client.submitOrder).toHaveBeenCalledTimes(1);
    [...s.orders.values()].find(o => o.side === 'sell')!.status = 'cancelled';
    s.market.bid = '101';
    await protectionCycle(s.venue, s.journal, () => NOW);
    expect(s.client.submitOrder).toHaveBeenCalledTimes(2);
    expect(s.client.submitOrder).toHaveBeenLastCalledWith(expect.objectContaining({ quantity: '0.6' }));
  });
  it('preserves manual holdings, reservations and native protection orders', async () => {
    const s = await setup({ bid: '97' }); s.market.extraBalance = '2'; s.market.reserved = '2';
    const manual: RevolutOrder = { ...s.entry, id: randomUUID(), clientOrderId: randomUUID(), side: 'sell', type: 'tpsl', quantity: '2', filledQuantity: '0', status: 'new' };
    s.orders.set(manual.id, manual);
    const snapshot = await s.venue.account();
    expect(snapshot.positions).toEqual(expect.arrayContaining([expect.objectContaining({ managed: false, quantity: '2' }), expect.objectContaining({ managed: true, quantity: '1' })]));
    await protectionCycle(s.venue, s.journal, () => NOW);
    expect(s.client.submitOrder).not.toHaveBeenCalled(); expect(s.client.cancelOrder).not.toHaveBeenCalled(); expect(s.orders.get(manual.id)).toEqual(manual);
  });
  it('does not adopt records from the native-protection policy or fabricate a monitor position', async () => {
    const s = await setup({ bid: '97' });
    await query("UPDATE app_settings SET value=value-'protectionMode' WHERE key=$1", [`execution:v1:${CONFIG.accountId}:decision:${s.buy.key}`]);
    expect((await s.venue.account()).positions.every(p => !p.managed)).toBe(true);
    s.client.getBalances.mockClear();
    expect(await protectionCycle(s.venue, s.journal, () => NOW)).toMatchObject({ status: 'idle', managedPositions: 0 });
    expect(s.client.getBalances).not.toHaveBeenCalled(); expect(s.client.submitOrder).not.toHaveBeenCalled();
  });
  it.each(['stale_quote', 'not_armed', 'insufficient_source_quantity'])('blocks execution when %s without changing source balances', async mode => {
    const s = await setup({ bid: '97', armed: mode !== 'not_armed' });
    if (mode === 'stale_quote') s.market.sourceAt = NOW - 16;
    if (mode === 'insufficient_source_quantity') s.market.extraBalance = '-0.1';
    expect(await protectionCycle(s.venue, s.journal, () => NOW)).toMatchObject({ status: 'blocked' });
    expect(s.client.submitOrder).not.toHaveBeenCalled(); expect(s.client.cancelOrder).not.toHaveBeenCalled();
  });
  it('shares one account lock across duplicate alarms and the strategy cycle', async () => {
    const s = await setup({ bid: '97' }), lease = (await s.journal.acquire(CONFIG.accountId))!;
    expect(await protectionCycle(s.venue, s.journal, () => NOW)).toMatchObject({ status: 'busy', retryAt: NOW + 5 });
    expect(s.client.submitOrder).not.toHaveBeenCalled(); await s.journal.release(lease);
  });
  it('keeps a non-expiring source-write claim across lost leases and rejects a second writer', async () => {
    const s = await setup(), lease = (await s.journal.acquire(CONFIG.accountId))!;
    const position = (await s.venue.account()).positions.find(p => p.managed)!;
    await s.venue.ensureProtection(position, lease);
    const snapshot = await s.venue.account();
    const exit = planExit(snapshot, [], [{ ...quote(), bid: '97', ask: '97.01' }], NOW)!;
    await s.journal.begin(lease, exit, NOW);
    const write = { id: `submit:${exit.key}`, decisionKey: exit.key, symbol: exit.symbol, kind: 'submit' as const, sourceOrderId: null, startedAt: NOW, settledAt: null };
    expect(await s.journal.claimSourceWrite(lease, write)).toBe(true);
    await query("UPDATE app_settings SET value=jsonb_set(value,'{expires}','0'::jsonb) WHERE key=$1", [lease.key]);
    const next = (await s.journal.acquire(CONFIG.accountId))!;
    await expect(s.journal.settleSourceWrite(lease, write.id, NOW)).rejects.toThrow('lock_lost');
    expect(await s.journal.claimSourceWrite(next, { ...write, id: 'different-write' })).toBe(false);
    await s.journal.release(next); expect(s.client.submitOrder).not.toHaveBeenCalled();
  });
});

describe('persistent protection wakeups in the existing Worker', () => {
  it('requires an authenticated watch acknowledgment and the configured cadence', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ scheduled: true, mode: 'mirsad', intervalSeconds: 10 }));
    await scheduleProtectionWatch(fetcher);
    expect(String(fetcher.mock.calls[0][0])).toBe('https://worker.test/watch-protection');
    fetcher.mockResolvedValueOnce(Response.json({ scheduled: true, mode: 'mirsad', intervalSeconds: 300 }));
    await expect(scheduleProtectionWatch(fetcher)).rejects.toThrow('protection_monitor_not_acknowledged');
    expect((await worker.fetch(new Request('https://worker.test/watch-protection', { method: 'POST', body: '{}' }), { EXECUTION_SCHEDULER_TOKEN: 'test' })).status).toBe(401);
  });
  it('retains the same watch across duplicate wakeups, eviction and host outages', async () => {
    const data = new Map<string, unknown>(); let alarm: number | null = null;
    const storage = { get: vi.fn(async (key: string) => data.get(key)), put: vi.fn(async (key: string, value: unknown) => { data.set(key, value); }),
      getAlarm: vi.fn(async () => alarm), setAlarm: vi.fn(async (at: number) => { alarm = at; }) };
    const env = { EXECUTION_SCHEDULER_TOKEN: 'test' }, watch = new OrderDeadline({ storage }, env);
    const request = () => new Request('https://deadline.internal/watch', { method: 'POST', body: JSON.stringify({ kind: 'protection' }) });
    expect(await (await watch.fetch(request())).json()).toMatchObject({ scheduled: true, intervalSeconds: 10 });
    const first = alarm; await watch.fetch(request()); expect(alarm).toBe(first);
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ status: 'idle' })); vi.stubGlobal('fetch', fetcher);
    await new OrderDeadline({ storage }, env).alarm();
    expect(data.get('job')).toEqual({ kind: 'protection' }); expect(String(fetcher.mock.calls[0][0])).toContain('/api/execution/protect');
    fetcher.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await new OrderDeadline({ storage }, env).alarm();
    expect(data.get('job')).toEqual({ kind: 'protection' }); expect(alarm).toBeGreaterThan(Date.now());
  });
});

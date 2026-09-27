import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase } from '../src/lib/db';
import type { RevolutTransaction } from '../src/lib/brokers/revolut';
import { emptyAccounting, extendValuations, sourceTradeResults, transactionMovement } from '../src/lib/execution/v1/accounting';
import { refreshSourceAccounting } from '../src/lib/execution/v1/account-evidence';
import { FEE_SCHEDULE, revolutCosts } from '../src/lib/execution/v1/costs';
import { SqlJournal, initialState, type DecisionRecord } from '../src/lib/execution/v1/journal';
import { planBuy } from '../src/lib/execution/v1/planner';
import { berlinBounds, evaluateRisk, neutralSeries } from '../src/lib/execution/v1/risk';
import { CONFIG, type SourceOrder } from '../src/lib/execution/v1/model';
import { managedPositions } from '../src/lib/execution/v1/managed-protection';
import { ConnectedRevolutVenue } from '../src/lib/execution/v1/revolut-venue';
import { NOW, account, instrument, quote, signal } from './execution-fixtures';

const leg = (netAmount: string, accountType: string, currency = 'EUR') => ({ netAmount, accountType, currency, fee: null, feeCurrency: null });
const tx = (overrides: Partial<RevolutTransaction> = {}): RevolutTransaction => ({ id: 'transfer-1', accountId: 'revolut-x',
  type: 'receive', status: 'completed', createdAt: new Date((NOW - 120) * 1000).toISOString(), processedAt: new Date((NOW - 60) * 1000).toISOString(),
  source: leg('100', 'revolut'), destination: leg('100', 'revolut_x'), orderId: null, ...overrides });
const baseline = berlinBounds(NOW).start;

describe('real source valuation evidence', () => {
  it('neutralizes a euro deposit without treating it as a win or increasing the return index', () => {
    const rows = extendValuations(emptyAccounting(), { at: NOW, amounts: { EUR: '1100' } }, [tx()], [], '1100');
    expect(rows[0]).toMatchObject({ at: baseline, equityEur: '1000' });
    expect(rows[1]).toMatchObject({ equityEur: '1100', beforeFlowEquityEur: '1000', netFlowEur: '100' });
    expect(neutralSeries(rows, NOW).series.at(-1)?.index).toBe('1');
    expect(evaluateRisk(initialState().risk, [], rows, true, NOW).dayReturn).toBe('0');
  });
  it('retains withdrawal fees as a loss and never subtracts them twice from net legs', () => {
    const withdrawal = tx({ type: 'send', source: leg('100.1', 'revolut_x'), destination: leg('100', 'revolut') });
    const rows = extendValuations(emptyAccounting(), { at: NOW, amounts: { EUR: '899.9' } }, [withdrawal], [], '899.9');
    expect(rows[0].equityEur).toBe('1000');
    expect(rows[1]).toMatchObject({ netFlowEur: '-100', beforeFlowEquityEur: '999.9' });
    expect(neutralSeries(rows, NOW).series.at(-1)?.index).toBe('0.9999');
  });
  it('groups equal-time transfers without inventing their ordering', () => {
    const deposit = tx(), withdrawal = tx({ id: 'second-transfer', type: 'send', source: leg('100.1', 'revolut_x'), destination: leg('100', 'revolut') });
    const rows = extendValuations(emptyAccounting(), { at: NOW, amounts: { EUR: '999.9' } }, [withdrawal, deposit], [], '999.9');
    expect(neutralSeries(rows, NOW).series.at(-1)?.index).toBe('0.9999');
  });
  it('values converted withdrawals from actual external net proceeds and counts the destination fee once', () => {
    const withdrawal = tx({ type: 'sell', source: leg('1', 'revolut_x', 'AAA'),
      destination: { ...leg('99.9', 'revolut', 'EUR'), fee: '0.1', feeCurrency: 'EUR' } });
    expect(transactionMovement(withdrawal)).toMatchObject({ delta: { AAA: '-1' }, flow: { EUR: '-99.9' } });
    const marks = [{ currency: 'AAA', at: baseline, price: '100' }, { currency: 'AAA', at: NOW - 60, price: '100' }];
    const rows = extendValuations(emptyAccounting(), { at: NOW, amounts: { EUR: '0', AAA: '9' } }, [withdrawal], marks, '900');
    expect(rows[0].equityEur).toBe('1000');
    expect(rows[1]).toMatchObject({ equityEur: '900', netFlowEur: '-99.9', beforeFlowEquityEur: '999.9' });
    expect(neutralSeries(rows, NOW).series.at(-1)?.index).toBe('0.9999');
  });
  it('requires disclosed conversion fee evidence and rejects invalid fees', () => {
    const withdrawal = tx({ type: 'sell', source: leg('1', 'revolut_x', 'AAA'), destination: leg('99.9', 'revolut', 'EUR') });
    expect(() => transactionMovement(withdrawal)).toThrow('accounting_transfer_fee_missing');
    expect(() => transactionMovement({ ...withdrawal, destination: { ...withdrawal.destination!, fee: '0.1', feeCurrency: 'AAA' } })).toThrow('accounting_transfer_fee_missing');
    expect(() => transactionMovement({ ...withdrawal, destination: { ...withdrawal.destination!, fee: '-0.1', feeCurrency: 'EUR' } })).toThrow('accounting_transfer_amount_invalid');
  });
  it('requires an event valuation for a converted payout currency that is not held in the account', () => {
    const withdrawal = tx({ type: 'sell', source: leg('1', 'revolut_x', 'AAA'),
      destination: { ...leg('1.98', 'revolut', 'BBB'), fee: '0.02', feeCurrency: 'BBB' } });
    const marks = [{ currency: 'AAA', at: baseline, price: '100' }, { currency: 'AAA', at: NOW - 60, price: '100' }];
    const end = { at: NOW, amounts: { EUR: '0', AAA: '9' } };
    expect(() => extendValuations(emptyAccounting(), end, [withdrawal], marks, '900')).toThrow('accounting_historical_price_missing');
    const rows = extendValuations(emptyAccounting(), end, [withdrawal], [...marks, { currency: 'BBB', at: NOW - 60, price: '50' }], '900');
    expect(rows[1]).toMatchObject({ netFlowEur: '-99', beforeFlowEquityEur: '999' });
    expect(neutralSeries(rows, NOW).series.at(-1)?.index).toBe('0.999');
  });
  it('uses dated source marks for a crypto transfer and retains later market gains', () => {
    const crypto = tx({ source: leg('1', 'revolut', 'AAA'), destination: leg('1', 'revolut_x', 'AAA') });
    const marks = [{ currency: 'AAA', at: baseline, price: '100' }, { currency: 'AAA', at: NOW - 60, price: '100' }];
    const rows = extendValuations(emptyAccounting(), { at: NOW, amounts: { EUR: '1000', AAA: '2' } }, [crypto], marks, '1220');
    expect(rows[1]).toMatchObject({ netFlowEur: '100', beforeFlowEquityEur: '1100', evidence: { markAt: NOW - 60 } });
    expect(Number(neutralSeries(rows, NOW).series.at(-1)?.index)).toBeCloseTo(1220 / 1200, 12);
    expect(() => extendValuations(emptyAccounting(), { at: NOW, amounts: { EUR: '1000', AAA: '2' } }, [crypto], [], '1220')).toThrow('historical_price_missing');
  });
  it.each(['pending', 'reverted'] as const)('does not declare %s movements complete', status => {
    expect(() => transactionMovement(tx({ status }))).toThrow(`accounting_transaction_${status}`);
  });
  it('separates an internal source trade from an externally funded purchase', () => {
    const internal = tx({ type: 'buy', source: leg('100.09', 'revolut_x'), destination: leg('1', 'revolut_x', 'AAA') });
    expect(transactionMovement(internal)).toMatchObject({ delta: { EUR: '-100.09', AAA: '1' }, flow: {} });
    expect(transactionMovement({ ...internal, source: leg('100.09', 'revolut') })?.flow).toEqual({ AAA: '1' });
  });
  it('rejects ambiguous source legs and a changed balance that has no matching source movement', () => {
    expect(() => transactionMovement(tx({ source: leg('1', 'revolut_x'), destination: leg('1', 'revolut_x') }))).toThrow('account_ambiguous');
    const old = { ...emptyAccounting(), anchor: { at: NOW - 300, amounts: { EUR: '1000' } } };
    expect(() => extendValuations(old, { at: NOW, amounts: { EUR: '2000' } }, [], [], '2000')).toThrow('source_reconciliation_failed');
  });
  it('does not reset drawdown at each reading and detects revisions to earlier transfer evidence', () => {
    const old = { ...emptyAccounting(), anchor: { at: NOW - 30, amounts: { EUR: '1100' } }, transactions: [tx()],
      observations: extendValuations(emptyAccounting(), { at: NOW - 30, amounts: { EUR: '1100' } }, [tx()], [], '1100') };
    expect(() => extendValuations(old, { at: NOW, amounts: { EUR: '1100' } }, [tx({ destination: leg('101', 'revolut_x') })], [], '1100')).toThrow('accounting_source_revision');
    const next = extendValuations(old, { at: NOW, amounts: { EUR: '1100' } }, [tx()], [], '1100');
    expect(next.slice(0, old.observations.length)).toEqual(old.observations);
    expect(() => extendValuations({ ...old, transactions: [] }, { at: NOW, amounts: { EUR: '1100' } }, [tx()], [], '1100')).toThrow('accounting_late_transaction');
  });
});

describe('size-specific entry cost', () => {
  const make = () => { const a = account(), q = quote(); q.depth = { bids: [{ price: q.bid, quantity: '10' }], asks: [{ price: q.ask, quantity: '10' }] };
    return { a, q, i: { ...instrument(), costs: revolutCosts(NOW) }, r: evaluateRisk(initialState().risk, [], a.equityHistory, true, NOW) }; };
  it('budgets the taker fee on both legs and counts the spread once', () => {
    const { a, q, i, r } = make(), p = planBuy(a, signal(), i, q, r, NOW).intent!;
    expect(p).not.toBeNull(); expect(i.costs.buyFeeRate).toBe(FEE_SCHEDULE.taker);
    expect(Number(p.estimatedCostFraction)).toBeCloseTo(0.0009 + 0.0009 * Number(q.bid) / Number(q.ask) + (Number(q.ask) - Number(q.bid)) / Number(q.ask), 12);
  });
  it('blocks absent or insufficient depth and excessive impact without raising the budget', () => {
    const { a, q, i, r } = make();
    expect(planBuy(a, signal(), i, { ...q, depth: undefined }, r, NOW).reason).toBe('order_book_missing');
    q.depth!.bids = [{ price: q.bid, quantity: '0.00001' }];
    expect(planBuy(a, signal(), i, q, r, NOW).reason).toBe('order_book_depth_insufficient');
    q.depth!.bids.push({ price: '90', quantity: '100' });
    expect(planBuy(a, signal(), i, q, r, NOW).reason).toBe('round_trip_cost_limit');
  });
  it('rechecks a detected source fee change even when other risk calculations are valid', () => {
    const { a, q, i, r } = make(); a.dataBlockers = ['source_fee_schedule_changed'];
    expect(planBuy(a, signal(), i, q, r, NOW).reason).toBe('source_fee_schedule_changed');
  });
});

describe('source-confirmed v1 trade accounting', () => {
  function trade(baseFee = false) {
    const a = account(), buyIntent = planBuy(a, signal(), instrument(), quote(), evaluateRisk(initialState().risk, [], a.equityHistory, true, NOW), NOW).intent!;
    const buy: SourceOrder = { id: 'buy-1', clientKey: buyIntent.key, symbol: 'AAA-EUR', side: 'buy', status: 'filled', quantity: '1', filledQuantity: '1',
      remainingBudgetEur: '0', submittedAt: NOW - 100, sourceAt: NOW - 90, managed: true, purpose: 'entry', averageFillPrice: '100', feeEur: baseFee ? '0.1' : '0.09', ...(baseFee ? { baseFeeQuantity: '0.001' } : {}) };
    const sell: SourceOrder = { ...buy, id: 'sell-1', clientKey: 'sell-key', side: 'sell', purpose: 'exit', filledQuantity: baseFee ? '0.999' : '1', averageFillPrice: '104', feeEur: baseFee ? '0.0935064' : '0.0936', baseFeeQuantity: undefined, sourceAt: NOW };
    const decisions: DecisionRecord[] = [{ key: buyIntent.key, intent: { ...buyIntent, quantity: '1' }, recordedAt: NOW - 100, signalId: 's', source: buy, status: 'acknowledged', protectionMode: 'mirsad' },
      { key: sell.clientKey, intent: { side: 'sell', key: sell.clientKey, symbol: sell.symbol, quantity: sell.filledQuantity, positionId: `mirsad:${buyIntent.key}`, signal: null, reason: 'target', reduceOnly: true, protectionIds: [], triggerQuote: { ...quote(), bid: '104' } }, recordedAt: NOW, signalId: null, source: sell, status: 'acknowledged' }];
    return { decisions, orders: [buy, sell], buy, sell };
  }
  it('records actual fees including a confirmed zero, without assuming missing costs', () => {
    const { decisions, orders, buy } = trade();
    expect(sourceTradeResults(decisions, orders).trades[0]).toMatchObject({ netPnlEur: '3.8164', feesEur: '0.1836', originalStop: null });
    buy.feeEur = '0'; expect(sourceTradeResults(decisions, orders).trades[0].netPnlEur).toBe('3.9064');
    buy.feeEur = null; expect(sourceTradeResults(decisions, orders).trades[0].netPnlEur).toBeNull();
  });
  it('keeps a partial exit open and never adopts unrelated source orders', () => {
    const { decisions, orders, sell } = trade(); sell.filledQuantity = '0.5';
    expect(sourceTradeResults(decisions, orders).trades).toEqual([]);
    expect(sourceTradeResults([], orders)).toEqual({ trades: [], complete: true });
  });
  it('accounts for base-denominated fees once and protects only the delivered quantity', () => {
    const { decisions, orders, buy } = trade(true);
    expect(sourceTradeResults(decisions, orders).trades[0].netPnlEur).toBe('3.8024936');
    const positions = managedPositions([{ accountId: 'revolut-x', currency: 'AAA', total: '0.999', available: '0.999', reserved: '0', observedAt: new Date(NOW * 1000).toISOString() }], [buy], [decisions[0]], []);
    expect(positions[0].quantity).toBe('0.999');
  });
});

describe('durable read-only accounting collector', () => {
  beforeEach(async () => { await closeDatabase(); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('VERCEL', ''); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); });
  afterEach(async () => { await closeDatabase(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  const client = () => ({ getBalances: vi.fn(async () => [{ accountId: 'revolut-x' as const, currency: 'EUR', total: '1000', available: '1000', reserved: '0', observedAt: new Date(NOW * 1000).toISOString() }]),
    getTransactionsPage: vi.fn(async () => ({ transactions: [] as RevolutTransaction[], nextCursor: null as string | null, sourceAt: new Date(NOW * 1000).toISOString() })),
    getTransaction: vi.fn(async () => tx()), getOrderBook: vi.fn(), getValuationCandles: vi.fn() });
  it('persists actual evidence while preserving the financial switches and releasing the account lock during source reads', async () => {
    const j = new SqlJournal(), c = client();
    c.getTransactionsPage.mockImplementation(async () => { const lease = await j.acquire(CONFIG.accountId); expect(lease).not.toBeNull(); await j.release(lease!); return { transactions: [], nextCursor: null, sourceAt: new Date(NOW * 1000).toISOString() }; });
    await refreshSourceAccounting(c, j, () => NOW);
    const saved = await new SqlJournal().accounting(CONFIG.accountId);
    expect(saved).toMatchObject({ lastError: null, anchor: { amounts: { EUR: '1000' } } });
    expect(saved?.observations).toHaveLength(2);
    const lease = (await j.acquire(CONFIG.accountId))!;
    expect(await j.state(lease)).toMatchObject({ entriesEnabled: false });
    expect((await j.state(lease)).executionArmed).not.toBe(true); await j.release(lease);
  });
  it('collects valuation evidence for externally received conversion currency without adding it to source balances', async () => {
    const j = new SqlJournal(), c = client();
    const withdrawal = tx({ type: 'sell', source: leg('1', 'revolut_x', 'AAA'),
      destination: { ...leg('1.98', 'revolut', 'BBB'), fee: '0.02', feeCurrency: 'BBB' } });
    c.getTransactionsPage.mockResolvedValue({ transactions: [withdrawal], nextCursor: null, sourceAt: new Date(NOW * 1000).toISOString() });
    c.getTransaction.mockResolvedValue(withdrawal);
    c.getValuationCandles.mockImplementation(async (symbol: string) => [baseline, NOW - 60].map(at => ({ at, price: symbol === 'AAA-EUR' ? '100' : '50' })));
    await refreshSourceAccounting(c, j, () => NOW);
    const saved = (await j.accounting(CONFIG.accountId))!;
    expect(saved.lastError).toBeNull();
    expect(saved.anchor?.amounts).toEqual({ EUR: '1000' });
    expect(c.getValuationCandles.mock.calls.map(args => args[0])).toEqual(['AAA-EUR', 'BBB-EUR']);
    expect(saved.observations.find(row => row.id.startsWith('flow:'))).toMatchObject({ netFlowEur: '-99', beforeFlowEquityEur: '1099' });
  });
  it('preserves the last successful evidence after a changed balance or repeated source cursor', async () => {
    const j = new SqlJournal(), c = client(); await refreshSourceAccounting(c, j, () => NOW);
    const saved = (await j.accounting(CONFIG.accountId))!;
    c.getBalances.mockResolvedValue([{ accountId: 'revolut-x', currency: 'EUR', total: '1001', available: '1001', reserved: '0', observedAt: new Date((NOW + 300) * 1000).toISOString() }]);
    c.getTransactionsPage.mockResolvedValue({ transactions: [], nextCursor: 'loop', sourceAt: new Date((NOW + 300) * 1000).toISOString() });
    await refreshSourceAccounting(c, j, () => NOW + 300);
    const blocked = (await j.accounting(CONFIG.accountId))!;
    expect(blocked.lastError).toBe('accounting_cursor_repeated'); expect(blocked.anchor).toEqual(saved.anchor); expect(blocked.observations).toEqual(saved.observations);
  });
  it('does not certify opening holdings when a recent filled source order is missing from movement coverage', async () => {
    const j = new SqlJournal(), c = client(); await refreshSourceAccounting(c, j, () => NOW);
    const venue = new ConnectedRevolutVenue({ journal: j, client: { ...c, getOrders: async () => [{ id: 'manual-source-trade',
      accountId: 'revolut-x', clientOrderId: 'manual', symbol: 'AAA-EUR', side: 'sell', type: 'market', status: 'filled',
      quantity: '1', filledQuantity: '1', averageFillPrice: '100', fee: '0', feeCurrency: 'EUR',
      createdAt: new Date((NOW - 60) * 1000).toISOString(), updatedAt: new Date(NOW * 1000).toISOString() }] },
      instruments: async () => [], candles: async () => [], market: vi.fn() }, () => NOW);
    const snapshot = await venue.account();
    expect(snapshot.dataBlockers).toContain('accounting_trade_coverage_incomplete');
    expect(evaluateRisk(initialState().risk, snapshot.trades, snapshot.equityHistory, snapshot.tradeHistoryComplete, NOW).entryBlocked).toBe('valuation_or_transfers_missing');
  });
  it('preflights a newly allocated buy without classifying that unsent intent as missing trade history, then submits only once', async () => {
    vi.stubEnv('EXECUTION_DEADLINE_URL', 'https://unit-test.invalid/schedule'); vi.stubEnv('EXECUTION_SCHEDULER_TOKEN', 'unit-test-only');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ scheduled: true, mode: 'mirsad', intervalSeconds: 10 })));
    const j = new SqlJournal(), c = client(); await refreshSourceAccounting(c, j, () => NOW);
    const api = { ...c, getOrders: vi.fn(async () => []), getOrder: vi.fn(), cancelOrder: vi.fn(),
      submitOrder: vi.fn(async (input: { clientOrderId: string; symbol: string; quantity: string; limitPrice?: string }) => ({ id: 'source-buy', accountId: 'revolut-x' as const,
        clientOrderId: input.clientOrderId, symbol: input.symbol, side: 'buy' as const, type: 'limit' as const, quantity: input.quantity,
        filledQuantity: '0', price: input.limitPrice, status: 'new' as const, createdAt: new Date(NOW * 1000).toISOString(), updatedAt: new Date(NOW * 1000).toISOString() })) };
    api.getOrderBook.mockResolvedValue({ symbol: 'AAA-EUR', sourceAt: NOW * 1000, readAt: NOW * 1000, bids: [{ price: '99.99', quantity: '10' }], asks: [{ price: '100', quantity: '10' }] });
    const venue = new ConnectedRevolutVenue({ client: api, journal: j, candles: async () => [], market: vi.fn(),
      instruments: async () => [{ symbol: 'AAA-EUR', base: 'AAA', quote: 'EUR', baseStep: '0.001', quoteStep: '0.01', minOrderSize: '0.001', minOrderSizeQuote: '1', maxOrderSize: '100', status: 'active', region: 'EEA', observedAt: new Date(NOW * 1000).toISOString() }] }, () => NOW);
    const snapshot = await venue.account(); expect(snapshot.dataBlockers).toEqual([]);
    const i = (await venue.instruments())[0], q = (await venue.quotes(['AAA-EUR']))[0];
    const intent = planBuy(snapshot, signal(), i, q, evaluateRisk(initialState().risk, [], snapshot.equityHistory, true, NOW), NOW).intent!;
    const lease = (await j.acquire(CONFIG.accountId))!;
    await j.save(lease, { ...initialState(), entriesEnabled: true, executionArmed: true }); // isolated SQL fixture only
    await j.saveProtectionHeartbeat(lease, { at: NOW, status: 'idle', managedPositions: 0, checkedPositions: 0, errors: [] });
    await j.begin(lease, intent, NOW);
    expect((await venue.account()).tradeHistoryComplete).toBe(false);
    expect(await venue.submit(intent, lease)).toMatchObject({ status: 'open', id: 'source-buy', clientKey: intent.key });
    await expect(venue.submit(intent, lease)).rejects.toThrow('source_write_already_attempted');
    expect(api.submitOrder).toHaveBeenCalledOnce(); await j.release(lease);
  });
});

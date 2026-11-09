import { describe, expect, it, vi } from 'vitest';
import { CONFIG, type Account, type FundingEvidence } from '../src/lib/execution/v1/model';
import { accountEntryBlockers, assertAccountFunding, validateQuoteConversion } from '../src/lib/execution/v1/readiness';
import { emptyAccounting, extendValuations, sourceAmounts, type AccountingEvidence } from '../src/lib/execution/v1/accounting';
import { refreshSourceAccounting } from '../src/lib/execution/v1/account-evidence';
import { initialState, type DecisionRecord, type Journal } from '../src/lib/execution/v1/journal';
import { planBuy } from '../src/lib/execution/v1/planner';
import { berlinBounds, evaluateRisk, neutralSeries } from '../src/lib/execution/v1/risk';
import type { ReportedOrder, SourceBalance, SourceOrderBook, SourceTransaction } from '../src/lib/execution/v1/source-model';
import { ConnectedWalletVenue } from '../src/lib/execution/v1/wallet-venue';
import { NOW, account, instrument, quote, signal, valuation } from './execution-fixtures';

const BASELINE = berlinBounds(NOW).start;
const funding = (overrides: Partial<FundingEvidence> = {}): FundingEvidence => ({ currency: 'USDC', available: '1000',
  reserved: '0', total: '1000', eurPerUnit: '0.9', sourceAt: NOW, sourceId: 'isolated-usdc-eur-feed-v1', ...overrides });
const physicalAccount = (): Account => ({ ...account(), funding: funding(), availableEur: '900',
  balances: [{ currency: 'USDC', available: '1000', reserved: '0', total: '1000' }], equityEur: '900',
  equityHistory: [valuation('start', BASELINE, '900'), valuation('now', NOW, '900')] });
const balance = (currency = 'USDC', total = '1000', now = NOW): SourceBalance => ({ accountId: CONFIG.accountId,
  currency, total, available: total, reserved: '0', observedAt: new Date(now * 1000).toISOString() });
const previous = (): AccountingEvidence => ({ ...emptyAccounting(), anchor: { at: NOW - 300, amounts: { USDC: '1000' } },
  observations: [valuation('start', BASELINE, '900'), valuation('old', NOW - 300, '900')] });

describe('physical funding and dated EUR valuation', () => {
  it('retains physical quote units without requiring or manufacturing a EUR balance', () => {
    expect(sourceAmounts([balance()], 'USDC')).toEqual({ USDC: '1000' });
    expect(() => sourceAmounts([balance()])).toThrow('accounting_eur_missing');
    expect(() => assertAccountFunding(physicalAccount(), NOW)).not.toThrow();
    expect(accountEntryBlockers(physicalAccount(), initialState().risk, NOW)).toEqual([]);
    expect(physicalAccount().balances.map(b => b.currency)).toEqual(['USDC']);
    expect(() => assertAccountFunding(account(), NOW)).not.toThrow();
  });

  it.each([
    { available: '999' }, { reserved: '1' }, { total: '1001' }, { currency: 'DAI' }, { available: '-1', total: '-1' },
  ])('rejects a funding amount or currency that differs from physical inventory: %j', change => {
    const a = physicalAccount(); a.funding = funding(change);
    expect(() => assertAccountFunding(a, NOW)).toThrow('funding_balance_mismatch');
    expect(accountEntryBlockers(a, initialState().risk, NOW)).toContain('funding_balance_mismatch');
  });

  it('uses available units after reservations exactly once when computing the EUR budget', () => {
    const a = physicalAccount();
    a.funding = funding({ available: '900', reserved: '100' }); a.availableEur = '810';
    a.balances = [{ currency: 'USDC', available: '900', reserved: '100', total: '1000' }];
    assertAccountFunding(a, NOW);
    const q = { ...quote(), conversion: { ...a.funding } };
    const risk = evaluateRisk(initialState().risk, [], a.equityHistory, true, NOW);
    const planned = planBuy(a, signal(), instrument(), q, risk, NOW);
    expect(planned.intent).toMatchObject({ budgetEur: '81', allocation: '0.10' });
    expect(Number(planned.intent!.estimatedCostFraction)).toBeLessThanOrEqual(0.004);
    const expensive = instrument(); expensive.costs!.sellFixedEur = '1';
    expect(planBuy(a, signal(), expensive, q, risk, NOW).reason).toBe('round_trip_cost_limit');
  });

  it('rejects a EUR budget that assumes token parity or counts reserved units as spendable', () => {
    const a = physicalAccount(); a.availableEur = '1000';
    expect(() => assertAccountFunding(a, NOW)).toThrow('funding_balance_mismatch');
    a.availableEur = '900'; a.funding = funding({ available: '900', reserved: '100' });
    a.balances = [{ currency: 'USDC', available: '900', reserved: '100', total: '1000' }];
    expect(() => assertAccountFunding(a, NOW)).toThrow('funding_balance_mismatch');
    expect(() => validateQuoteConversion(funding({ currency: 'EUR', eurPerUnit: '2' }), NOW)).toThrow('funding_conversion_invalid');
  });

  it('does not plan against stale FX or a quote converted using a different rate snapshot', () => {
    const a = physicalAccount(), risk = evaluateRisk(initialState().risk, [], a.equityHistory, true, NOW);
    const q = { ...quote(), conversion: funding({ eurPerUnit: '0.95' }) };
    expect(planBuy(a, signal(), instrument(), q, risk, NOW).reason).toBe('funding_conversion_invalid');
    q.conversion = funding({ sourceAt: NOW - 16 });
    expect(planBuy(a, signal(), instrument(), q, risk, NOW).reason).toBe('funding_conversion_stale');
    q.conversion = funding(); a.funding!.sourceAt = NOW - 31;
    expect(planBuy(a, signal(), instrument(), q, risk, NOW).reason).toBe('funding_conversion_stale');
  });

  it.each(['0', '-1', 'NaN', 'Infinity', '1e0'])('rejects an invalid conversion rate %s', eurPerUnit => {
    expect(() => validateQuoteConversion(funding({ eurPerUnit }), NOW)).toThrow('funding_conversion_invalid');
  });

  it.each([{ sourceId: '' }, { sourceId: 'secret\nbody' }, { currency: 'usdc' }])('rejects malformed conversion identity %j', change => {
    expect(() => validateQuoteConversion(funding(change), NOW)).toThrow('funding_conversion_invalid');
  });

  it.each([NOW - CONFIG.accountMaxAgeSeconds - 1, NOW + 1, Number.NaN, NOW + 0.5])('blocks stale or invalid funding timestamps %s despite a fresh account', sourceAt => {
    const a = physicalAccount(); a.funding = funding({ sourceAt });
    expect(accountEntryBlockers(a, initialState().risk, NOW)).toContain('funding_conversion_stale');
  });

  it('keeps a fresh observation distinct from a dated oracle round within its approved heartbeat', () => {
    const a = physicalAccount();
    a.funding = funding({ sourceId: 'isolated-usdc-eur:round-123', rateAt: NOW - 3600, rateMaxAgeSeconds: 86400 });
    expect(() => assertAccountFunding(a, NOW)).not.toThrow();
    expect(() => validateQuoteConversion(a.funding!, NOW)).not.toThrow();
    a.funding.rateAt = NOW - 86401;
    expect(() => assertAccountFunding(a, NOW)).toThrow('funding_conversion_stale');
    // Re-reading an old oracle rate does not change its actual update time.
    a.funding.sourceAt = NOW;
    expect(accountEntryBlockers(a, initialState().risk, NOW)).toContain('funding_conversion_stale');
  });

  it.each([
    { rateAt: NOW - 3600 }, { rateMaxAgeSeconds: 86400 }, { rateAt: NOW + 1, rateMaxAgeSeconds: 86400 },
    { rateAt: -1, rateMaxAgeSeconds: 86400 }, { rateAt: NOW, rateMaxAgeSeconds: 0 },
    { rateAt: NOW, rateMaxAgeSeconds: 90001 }, { rateAt: NOW, rateMaxAgeSeconds: 1.5 },
  ])('rejects incomplete or unbounded oracle freshness policy %j', policy => {
    expect(() => validateQuoteConversion(funding(policy), NOW)).toThrow('funding_conversion_invalid');
  });

  it('values FX movement without inventing a physical transfer or resetting the anchor', () => {
    const old = previous();
    const rows = extendValuations(old, { at: NOW, amounts: { USDC: '1000' } }, [], [], '950');
    expect(rows.at(-1)).toMatchObject({ equityEur: '950', netFlowEur: '0', evidence: { transactionIds: [] } });
    expect(rows.filter(v => v.id.startsWith('flow:'))).toEqual([]);
    expect(Number(neutralSeries(rows, NOW).series.at(-1)!.index)).toBeCloseTo(950 / 900, 12);
    expect(old.anchor?.amounts).toEqual({ USDC: '1000' });
    const loss = extendValuations(old, { at: NOW, amounts: { USDC: '1000' } }, [], [], '880');
    expect(evaluateRisk(initialState().risk, [], loss, true, NOW)).toMatchObject({ entryBlocked: 'daily_loss_limit' });
  });

  it('neutralizes a token deposit at its dated EUR rate and retains subsequent FX performance', () => {
    const t: SourceTransaction = { id: 'isolated-deposit', accountId: CONFIG.accountId, status: 'completed', type: 'receive',
      source: { netAmount: '100', currency: 'USDC', accountType: 'external', fee: '0', feeCurrency: 'USDC' },
      destination: { netAmount: '100', currency: 'USDC', accountType: 'wallet', fee: '0', feeCurrency: 'USDC' },
      createdAt: new Date((NOW - 120) * 1000).toISOString(), processedAt: new Date((NOW - 60) * 1000).toISOString(), orderId: null };
    const marks = [BASELINE, NOW - 60].map(at => ({ currency: 'USDC', at, price: '0.9' }));
    const rows = extendValuations(emptyAccounting(), { at: NOW, amounts: { USDC: '1100' } }, [t], marks, '1100');
    expect(rows[0].equityEur).toBe('900');
    expect(rows.find(v => v.id.startsWith('flow:'))).toMatchObject({ netFlowEur: '90', equityEur: '990', beforeFlowEquityEur: '900' });
    expect(Number(neutralSeries(rows, NOW).series.at(-1)!.index)).toBeCloseTo(1100 / 990, 12);
    expect(() => extendValuations(emptyAccounting(), { at: NOW, amounts: { USDC: '1100' } }, [t], [], '1100')).toThrow('accounting_historical_price_missing');
  });
});

function collector() {
  let now = NOW, rate = '0.9', saved: AccountingEvidence | null = null;
  const journal = {
    accounting: vi.fn(async () => saved ? structuredClone(saved) : null),
    acquire: vi.fn(async () => ({ accountId: CONFIG.accountId, token: 'isolated-test-lease' })), release: vi.fn(async () => undefined),
    saveAccounting: vi.fn(async (_lease: unknown, next: AccountingEvidence) => { saved = structuredClone(next); return true; }),
  } as unknown as Journal;
  const client = {
    getBalances: vi.fn(async () => [balance('USDC', '1000', now), balance('ETH', '1', now)]),
    getFunding: vi.fn(async () => funding({ sourceAt: now, eurPerUnit: rate })),
    getTransactionsPage: vi.fn(async () => ({ transactions: [] as SourceTransaction[], nextCursor: null, sourceAt: new Date(now * 1000).toISOString() })),
    getTransaction: vi.fn(async (): Promise<SourceTransaction> => { throw new Error('unused'); }),
    getOrderBook: vi.fn(async (symbol: string): Promise<SourceOrderBook> => ({ symbol, sourceAt: now * 1000, readAt: now * 1000,
      bids: [{ price: symbol === 'USDC-EUR' ? rate : '2000', quantity: '10000' }], asks: [],
      ...(symbol === 'USDC-EUR' ? { conversion: funding({ sourceAt: now, eurPerUnit: rate }) } : {}) })),
    getValuationCandles: vi.fn(async (symbol: string) => [{ at: BASELINE, price: symbol === 'USDC-EUR' ? '0.9' : '2000' }]),
  };
  return { client, journal, read: () => saved!, clock: () => now, advance: (nextRate = '0.95') => { now += 300; rate = nextRate; } };
}

describe('physical source accounting snapshots', () => {
  it('values manual WETH remainder plus a managed fill exactly once without adopting the manual inventory or inventing drawdown', async () => {
    const a = physicalAccount(); a.funding = funding({ eurPerUnit: '1' }); a.availableEur = '1000'; a.equityEur = '1200';
    a.equityHistory = [valuation('start', BASELINE, '1200'), valuation('now', NOW, '1200')];
    const risk = evaluateRisk(initialState().risk, [], a.equityHistory, true, NOW);
    const planned = planBuy(a, signal('WETH-EUR'), instrument('WETH-EUR'), { ...quote('WETH-EUR'), conversion: a.funding }, risk, NOW).intent!;
    const intent = { ...planned, quantity: '1' };
    const order: ReportedOrder = { id: 'isolated-managed-buy', clientOrderId: 'isolated-managed-client', accountId: CONFIG.accountId,
      symbol: 'WETH-EUR', side: 'buy', type: 'limit', status: 'filled', quantity: '1', filledQuantity: '1', price: intent.limitPrice,
      averageFillPrice: '100', fee: '0', feeCurrency: 'EUR', createdAt: new Date((NOW - 60) * 1000).toISOString(), updatedAt: new Date(NOW * 1000).toISOString() };
    const decision: DecisionRecord = { key: intent.key, signalId: intent.signal.id, intent, status: 'acknowledged', source: null,
      recordedAt: NOW - 60, sourceIdentity: { clientOrderId: order.clientOrderId }, protectionMode: 'mirsad' };
    const tx: SourceTransaction = { id: 'isolated-managed-transaction', accountId: CONFIG.accountId, type: 'buy', status: 'completed', orderId: order.id,
      createdAt: order.createdAt, processedAt: order.createdAt,
      source: { netAmount: '100', currency: 'USDC', accountType: 'wallet', fee: '0', feeCurrency: 'USDC' },
      destination: { netAmount: '1', currency: 'WETH', accountType: 'wallet', fee: '0', feeCurrency: 'WETH' } };
    const evidence: AccountingEvidence = { ...emptyAccounting(), checkedAt: NOW, anchor: { at: NOW, amounts: { USDC: '1000', WETH: '2' } },
      observations: a.equityHistory, transactions: [tx] };
    const journal = { accountDecisions: async () => [decision], protections: async () => [], accounting: async () => evidence } as unknown as Journal;
    const venue = new ConnectedWalletVenue({ journal,
      client: { getBalances: async () => [balance(), balance('WETH', '2')], getFunding: async () => a.funding!,
        getOrders: async () => [order], getOrder: async () => order,
        getOrderBook: async symbol => ({ symbol, sourceAt: NOW * 1000, readAt: NOW * 1000,
          bids: [{ price: '100', quantity: '2' }], asks: [{ price: '100', quantity: '2' }] }),
        getFillsForOrders: async () => ({ truncated: false, fills: [{ id: 'isolated-source-fill', orderId: order.id, accountId: CONFIG.accountId,
          symbol: order.symbol, side: 'buy', quantity: '1', price: '100', baseCurrency: 'WETH', quoteCurrency: 'EUR',
          fee: '0', feeCurrency: 'EUR', createdAt: order.createdAt, maker: false }] }) },
      instruments: async () => [], candles: async () => [], market: async () => { throw new Error('unused'); } }, () => NOW);
    const snapshot = await venue.account();
    expect(snapshot.positions.map(p => ({ managed: p.managed, quantity: p.quantity, marketValueEur: p.marketValueEur })))
      .toEqual([{ managed: false, quantity: '1', marketValueEur: '100' }, { managed: true, quantity: '1', marketValueEur: '100' }]);
    expect(snapshot.equityEur).toBe('1200');
    expect(snapshot.dataBlockers).toEqual([]);
    expect(evaluateRisk(initialState().risk, snapshot.trades, snapshot.equityHistory, snapshot.tradeHistoryComplete, NOW))
      .toMatchObject({ dayReturn: '0', drawdown: '0', entryBlocked: null });
  });

  it('allows a newer observation time of the same immutable rate basis while requiring both observations fresh', async () => {
    const c = collector(); c.client.getFunding.mockResolvedValueOnce(funding({ sourceAt: NOW - 1 })).mockResolvedValueOnce(funding());
    await refreshSourceAccounting(c.client, c.journal, c.clock);
    expect(c.read().lastError).toBeNull(); expect(c.read().anchor?.amounts).toEqual({ USDC: '1000', ETH: '1' });
  });

  it('marks all non-EUR currencies, persists actual units and measures FX change across reads', async () => {
    const c = collector(); await refreshSourceAccounting(c.client, c.journal, c.clock);
    expect(c.read()).toMatchObject({ lastError: null, anchor: { amounts: { USDC: '1000', ETH: '1' } } });
    expect(c.read().observations.at(-1)?.equityEur).toBe('2900');
    expect(c.client.getValuationCandles.mock.calls.map(([s]) => s).sort()).toEqual(['ETH-EUR', 'USDC-EUR']);
    c.advance(); await refreshSourceAccounting(c.client, c.journal, c.clock);
    expect(c.read().lastError).toBeNull();
    expect(c.read().anchor?.amounts).toEqual({ USDC: '1000', ETH: '1' });
    expect(c.read().observations.at(-1)).toMatchObject({ equityEur: '2950', netFlowEur: '0' });
    expect(c.read().transactions).toEqual([]);
  });

  it('preserves prior evidence if conversion changes while the physical snapshot is read', async () => {
    const c = collector(); await refreshSourceAccounting(c.client, c.journal, c.clock); const old = structuredClone(c.read());
    c.advance(); c.client.getFunding.mockResolvedValueOnce(funding({ sourceAt: NOW + 300, eurPerUnit: '0.95' }))
      .mockResolvedValueOnce(funding({ sourceAt: NOW + 300, eurPerUnit: '0.96' }));
    await refreshSourceAccounting(c.client, c.journal, c.clock);
    expect(c.read().lastError).toBe('accounting_funding_changed_during_read');
    expect(c.read().anchor).toEqual(old.anchor); expect(c.read().observations).toEqual(old.observations);
  });

  it('refuses a funding snapshot whose physical amount is not present in balances', async () => {
    const c = collector(); c.client.getFunding.mockResolvedValue(funding({ available: '1001', total: '1001' }));
    await refreshSourceAccounting(c.client, c.journal, c.clock);
    expect(c.read().lastError).toBe('funding_balance_mismatch');
    expect(c.read().anchor).toBeNull(); expect(c.client.getTransactionsPage).not.toHaveBeenCalled();
  });

  it('refuses stale conversion evidence despite current physical balances', async () => {
    const c = collector(); c.client.getFunding.mockResolvedValue(funding({ sourceAt: NOW - 31 }));
    await refreshSourceAccounting(c.client, c.journal, c.clock);
    expect(c.read().lastError).toBe('funding_conversion_stale'); expect(c.read().anchor).toBeNull();
  });

  it('rejects a valuation quote from a different funding conversion identity', async () => {
    const c = collector(); const original = c.client.getOrderBook.getMockImplementation()!;
    c.client.getOrderBook.mockImplementation(async symbol => {
      const book = await original(symbol);
      return symbol === 'USDC-EUR' ? { ...book, conversion: funding({ sourceId: 'different-isolated-feed' }) } : book;
    });
    await refreshSourceAccounting(c.client, c.journal, c.clock);
    expect(c.read().lastError).toBe('funding_conversion_invalid'); expect(c.read().anchor).toBeNull();
  });
});

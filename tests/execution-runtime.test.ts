import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, query } from '../src/lib/db';
import { SqlJournal, initialState } from '../src/lib/execution/v1/journal';
import { configuredSymbols } from '../src/lib/execution/v1/host';
import { installWalletExecutionSource } from '../src/lib/wallet/execution-connection';
import { testWalletSource } from './execution-fixtures';
import { setSetting } from '../src/lib/services';
import { saveOwnerStrategySelection, strategyEntrySelection } from '../src/lib/wallet/selection-service';
import { STRATEGY_SELECTION_KEY } from '../src/lib/wallet/strategy-selection';
import { CONFIG, type Intent, type SourceOrder } from '../src/lib/execution/v1/model';
import { cycle } from '../src/lib/execution/v1/runner';
import { cancelDeadline, type CancellationPort } from '../src/lib/execution/v1/deadline';
import { planBuy } from '../src/lib/execution/v1/planner';
import { evaluateRisk } from '../src/lib/execution/v1/risk';
import { emptyIndicators } from '../src/lib/execution/v1/strategy';
import { loadCandles } from '../src/lib/execution/v1/feed';
import { dailyReport, buildReport } from '../src/lib/execution/v1/reporting';
import { scheduleCancellation } from '../src/lib/execution/v1/scheduler';
import worker, { OrderDeadline } from '../automation/execution-v1-worker.mjs';
import { NOW, account, candle, instrument, order, position, quote, signal } from './execution-fixtures';
const makePort = () => {
  const a = account();
  const port: CancellationPort = {
    accountId: CONFIG.accountId,
    capabilities: vi.fn(async () => ({ idempotentOrders: true, fencedWrites: true, attachedProtection: false, managedProtection: true, coordinatedExits: true, cancelRemainder: true, cancellationTimer: true })),
    reconcile: vi.fn(async () => undefined), account: vi.fn(async () => structuredClone(a)),
    quotes: vi.fn(async (symbols: string[]) => symbols.map(s => quote(s))), instruments: vi.fn(async () => ['AAA-EUR', 'BBB-EUR', 'CCC-EUR'].map(s => instrument(s))),
    candles: vi.fn(async () => []), lookup: vi.fn(async () => ({ order: null, authoritative: true })),
    ensureProtection: vi.fn(async () => undefined), prepareExit: vi.fn(async i => ({ ready: true, quantity: i.quantity })),
    submit: vi.fn(async (i: Intent): Promise<SourceOrder> => ({ ...order(i.symbol), clientKey: i.key, side: i.side, quantity: i.quantity, purpose: i.side === 'buy' ? 'entry' : 'exit' })),
    armCancellation: vi.fn(async () => undefined), cancelRemainder: vi.fn(async () => undefined),
  };
  return { port, a };
};
async function seed(j: SqlJournal, symbols = ['AAA-EUR'], entriesEnabled = true) {
  const lease = (await j.acquire(CONFIG.accountId))!; const state = initialState(); state.entriesEnabled = entriesEnabled;
  for (const symbol of ['AAA-EUR', 'BBB-EUR', 'CCC-EUR']) state.indicators[symbol] = { ...emptyIndicators(), count: 1000, lastCloseTime: NOW, ema20: '100', ema50: '99', ema200: '90' };
  state.pendingSignals = symbols.map(s => signal(s)); await j.save(lease, state); await j.release(lease);
}
function installOpportunityUniverse() {
  const base = testWalletSource();
  base.binding.markets = ['AAA-EUR', 'BBB-EUR', 'CCC-EUR'].map((symbol, i) => ({ ...base.binding.markets[i], symbol }));
  const source = { ...base, verifyGrant: vi.fn(async () => true), client: { getBalances: async () => [], getOrders: async () => [] },
    instruments: async () => [], market: async () => { throw new Error('unused'); }, candles: async () => [] };
  installWalletExecutionSource(source); return source;
}
async function corruptSelectionMode() {
  await query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',
    [STRATEGY_SELECTION_KEY, JSON.stringify({ storageVersion: 1, revision: 1, updatedAt: new Date(NOW * 1000).toISOString(),
      policy: { schemaVersion: 1, accountId: CONFIG.accountId, strategyVersion: CONFIG.strategyVersion, mode: 'untrusted-mode' } })]);
}
beforeEach(async () => {
  await closeDatabase(); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('VERCEL', ''); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://');
});
afterEach(async () => { installWalletExecutionSource(null); vi.useRealTimers(); await closeDatabase(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('durable SQL ownership and orchestration', () => {
  it('applies executable-size refinement before ranking and again before recording the single decision', async () => {
    const j = new SqlJournal(); await seed(j, ['AAA-EUR', 'BBB-EUR']); const { port } = makePort();
    port.entryPlan = vi.fn(async (a, s, i, q, risk, now) => {
      expect(await j.accountDecisions(CONFIG.accountId)).toEqual([]);
      return planBuy(a, s, { ...i, costs: { ...i.costs!, buyFeeRate: s.symbol === 'BBB-EUR' ? '0.0001' : '0.001',
        sellFeeRate: s.symbol === 'BBB-EUR' ? '0.0001' : '0.001' } }, q, risk, now);
    });
    expect(await cycle(port, j, ['AAA-EUR', 'BBB-EUR'], () => NOW)).toMatchObject({ status: 'submitted', intent: { symbol: 'BBB-EUR' } });
    expect(port.entryPlan).toHaveBeenCalledTimes(3); expect(port.submit).toHaveBeenCalledOnce();
    expect((await j.accountDecisions(CONFIG.accountId))).toHaveLength(1);
  });
  it.each(['conflict', 'unavailable'] as const)('keeps the strategy cycle blocked on %s source evidence, including would-be exits', async status => {
    const j = new SqlJournal(); await seed(j); const { port, a } = makePort();
    a.positions = [position()];
    a.reportEvidence = { readAt: NOW, status, issues: ['report_fill_price_mismatch'], orders: [] };
    vi.mocked(port.quotes).mockImplementation(async symbols => symbols.map(s => ({ ...quote(s), bid: '97' })));
    expect(await cycle(port, j, ['AAA-EUR'], () => NOW)).toMatchObject({ status: 'blocked', reason: 'report_fill_price_mismatch' });
    expect(port.prepareExit).not.toHaveBeenCalled(); expect(port.submit).not.toHaveBeenCalled();
    expect(port.armCancellation).not.toHaveBeenCalled();
  });
  it('uses the saved partial wallet watchlist only when its market mapping is approved', async () => {
    expect(await configuredSymbols(NOW)).toEqual([]);
    const source = { ...testWalletSource(), client: { getBalances: async () => [], getOrders: async () => [] },
      instruments: async () => [], market: async () => { throw new Error('unused'); }, candles: async () => [] };
    installWalletExecutionSource(source);
    await setSetting('wallet:strategy:watchlist', ['SOL-EUR', 'AAA-EUR']);
    expect(await configuredSymbols(NOW)).toEqual(['SOL-EUR', 'AAA-EUR']);
    source.binding.markets = [];
    expect(await configuredSymbols(NOW)).toEqual([]);
  });
  it('does not replace a missing or explicitly empty wallet watchlist with approved markets or legacy selections', async () => {
    installWalletExecutionSource({ ...testWalletSource(), client: { getBalances: async () => [], getOrders: async () => [] },
      instruments: async () => [], market: async () => { throw new Error('unused'); }, candles: async () => [] });
    await setSetting('watchlist', ['ETH-EUR']);
    expect(await configuredSymbols(NOW)).toEqual([]);
    await saveOwnerStrategySelection('manual', null);
    expect(await configuredSymbols(NOW)).toEqual([]);
    await setSetting('wallet:strategy:watchlist', []);
    expect(await configuredSymbols(NOW)).toEqual([]);
  });
  it('expands only an explicit opportunities policy to the verified mapped universe, bounded by CONFIG restrictions', async () => {
    const source = installOpportunityUniverse();
    await setSetting('wallet:strategy:watchlist', []); await setSetting('watchlist', ['OLD-EUR']);
    await setSetting('discovery:wallet:v1:cohort', ['PAPER-EUR']);
    expect(await configuredSymbols(NOW)).toEqual([]);
    await saveOwnerStrategySelection('opportunities', null);
    expect(await configuredSymbols(NOW)).toEqual(['AAA-EUR', 'BBB-EUR', 'CCC-EUR']);
    const symbols = CONFIG.symbols as string[], original = [...symbols];
    try {
      symbols.splice(0, symbols.length, 'BBB-EUR', 'PAPER-EUR');
      expect(await configuredSymbols(NOW)).toEqual(['BBB-EUR']);
      source.verifyGrant.mockResolvedValue(false);
      expect(await configuredSymbols(NOW)).toEqual([]);
    } finally { symbols.splice(0, symbols.length, ...original); }
    expect((await query('SELECT value FROM app_settings WHERE key=$1', ['wallet:strategy:watchlist'])).rows).toEqual([{ value: [] }]);
  });
  it('keeps existing signal eligibility, cost ranking, sizing and one-entry cancellation ordering in opportunities mode', async () => {
    installOpportunityUniverse(); await saveOwnerStrategySelection('opportunities', null);
    await setSetting('wallet:strategy:watchlist', []);
    const j = new SqlJournal(); await seed(j, ['AAA-EUR', 'BBB-EUR', 'CCC-EUR', 'PAPER-EUR']);
    const { port } = makePort();
    vi.mocked(port.instruments).mockImplementation(async () => ['AAA-EUR', 'BBB-EUR', 'CCC-EUR', 'PAPER-EUR'].map(symbol => {
      const item = instrument(symbol);
      return { ...item, costs: { ...item.costs!,
        buyFeeRate: symbol === 'BBB-EUR' ? '0.0005' : symbol === 'CCC-EUR' ? '0.003' : '0.001',
        sellFeeRate: symbol === 'BBB-EUR' ? '0.0005' : symbol === 'CCC-EUR' ? '0.003' : '0.001' } };
    }));
    const result = await cycle(port, j, await configuredSymbols(NOW), () => NOW);
    expect(result).toMatchObject({ status: 'submitted', intent: { side: 'buy', symbol: 'BBB-EUR', type: 'limit',
      allocation: '0.10', budgetEur: '100', expiresAt: NOW + 60, stopFraction: '0.02', targetFraction: '0.04' } });
    expect(result.blocks).toContainEqual({ symbol: 'CCC-EUR', reason: 'round_trip_cost_limit' });
    expect(vi.mocked(port.candles).mock.calls.map(([symbol]) => symbol)).toEqual(['AAA-EUR', 'BBB-EUR', 'CCC-EUR']);
    expect(port.submit).toHaveBeenCalledOnce(); expect(port.armCancellation).toHaveBeenCalledOnce();
    expect(vi.mocked(port.armCancellation).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(port.submit).mock.invocationCallOrder[0]);
    expect((await query('SELECT value FROM app_settings WHERE key=$1', ['wallet:strategy:watchlist'])).rows).toEqual([{ value: [] }]);
  });
  it('does not invent an entry opportunity without an existing eligible EMA signal', async () => {
    installOpportunityUniverse(); await saveOwnerStrategySelection('opportunities', null);
    const j = new SqlJournal(); await seed(j, []); const { port } = makePort();
    expect(await cycle(port, j, await configuredSymbols(NOW), () => NOW)).toMatchObject({ status: 'waiting' });
    expect(port.candles).toHaveBeenCalledTimes(3); expect(port.submit).not.toHaveBeenCalled(); expect(port.armCancellation).not.toHaveBeenCalled();
  });
  it('blocks new entries for an invalid stored mode without falling back to mapped markets or the saved manual list', async () => {
    installOpportunityUniverse(); await setSetting('wallet:strategy:watchlist', ['AAA-EUR']); await corruptSelectionMode();
    expect(await strategyEntrySelection(() => NOW)).toMatchObject({ mode: 'invalid', symbols: [], reason: 'wallet_strategy_selection_invalid' });
    const j = new SqlJournal(); await seed(j); const { port } = makePort();
    const result = await cycle(port, j, await configuredSymbols(NOW), () => NOW);
    expect(result.blocks).toContainEqual({ reason: 'configured_symbols_missing' });
    expect(port.submit).not.toHaveBeenCalled(); expect(port.armCancellation).not.toHaveBeenCalled();
  });
  it('deduplicates the saved selection and rejects unapproved or malformed markets without substituting any', async () => {
    installWalletExecutionSource({ ...testWalletSource(), client: { getBalances: async () => [], getOrders: async () => [] },
      instruments: async () => [], market: async () => { throw new Error('unused'); }, candles: async () => [] });
    await setSetting('wallet:strategy:watchlist', ['SOL-EUR', 'DOGE-EUR', 'SOL-EUR', 'ETH-EUR', null, 7, 'eth-eur']);
    expect(await configuredSymbols(NOW)).toEqual(['SOL-EUR', 'ETH-EUR']);
    await setSetting('wallet:strategy:watchlist', { symbols: ['AAA-EUR'] });
    expect(await configuredSymbols(NOW)).toEqual([]);
  });
  it('intersects the config restriction with the saved selection without adding configured or unapproved markets', async () => {
    installWalletExecutionSource({ ...testWalletSource(), client: { getBalances: async () => [], getOrders: async () => [] },
      instruments: async () => [], market: async () => { throw new Error('unused'); }, candles: async () => [] });
    const symbols = CONFIG.symbols as string[], original = [...symbols];
    try {
      symbols.splice(0, symbols.length, 'AAA-EUR', 'ETH-EUR', 'DOGE-EUR');
      await setSetting('wallet:strategy:watchlist', ['SOL-EUR', 'DOGE-EUR', 'ETH-EUR']);
      expect(await configuredSymbols(NOW)).toEqual(['ETH-EUR']);
      await setSetting('wallet:strategy:watchlist', []);
      expect(await configuredSymbols(NOW)).toEqual([]);
      await query('DELETE FROM app_settings WHERE key=$1', ['wallet:strategy:watchlist']);
      expect(await configuredSymbols(NOW)).toEqual([]);
    } finally { symbols.splice(0, symbols.length, ...original); }
  });
  it('does not enter a queued signal after the saved watchlist is cleared', async () => {
    installWalletExecutionSource({ ...testWalletSource(), client: { getBalances: async () => [], getOrders: async () => [] },
      instruments: async () => [], market: async () => { throw new Error('unused'); }, candles: async () => [] });
    await setSetting('wallet:strategy:watchlist', []);
    const j = new SqlJournal(); await seed(j);
    const { port } = makePort();
    const result = await cycle(port, j, await configuredSymbols(NOW), () => NOW);
    expect(result.blocks).toContainEqual({ reason: 'configured_symbols_missing' });
    expect(port.submit).not.toHaveBeenCalled(); expect(port.armCancellation).not.toHaveBeenCalled();
  });
  it.each([['empty-manual', 'stop'], ['empty-manual', 'reverse_cross'], ['invalid-policy', 'stop'], ['invalid-policy', 'reverse_cross']] as const)(
    'continues managed protection and exits with %s selection and %s trigger', async (selection, reason) => {
    installWalletExecutionSource({ ...testWalletSource(), client: { getBalances: async () => [], getOrders: async () => [] },
      instruments: async () => [], market: async () => { throw new Error('unused'); }, candles: async () => [] });
    await setSetting('wallet:strategy:watchlist', []);
    if (selection === 'invalid-policy') await corruptSelectionMode();
    const j = new SqlJournal(); await seed(j, ['BBB-EUR']);
    const lease = (await j.acquire(CONFIG.accountId))!;
    const state = await j.state(lease);
    if (reason === 'reverse_cross') state.pendingSignals.push(signal('AAA-EUR', 'sell'));
    await j.save(lease, state);
    await j.saveProtection(lease, { entryKey: 'a'.repeat(64), entryOrderId: 'tracked-entry', symbol: 'AAA-EUR',
      quantity: '1', averageFillPrice: '100', stop: '98', originalStop: '98', target: '104', entryFilled: '1',
      exitedQuantity: '0', sourceAt: NOW, updatedAt: NOW, status: 'watching', trigger: null, lastError: null });
    await j.release(lease);
    const { port, a } = makePort(); a.positions = [position()];
    vi.mocked(port.quotes).mockImplementation(async symbols => symbols.map(s => ({ ...quote(s), bid: reason === 'stop' ? '97' : '99.99' })));
    const result = await cycle(port, j, await configuredSymbols(NOW), () => NOW);
    expect(result.intent).toMatchObject({ symbol: 'AAA-EUR', side: 'sell', reason, quantity: '1' });
    expect(port.candles).toHaveBeenCalledWith('AAA-EUR', NOW);
    expect(port.ensureProtection).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'AAA-EUR' }), expect.any(Object));
    expect(port.submit).toHaveBeenCalledOnce(); expect(port.armCancellation).not.toHaveBeenCalled();
  });
  it('grants one concurrent lock and fences stale owners without releasing another owner', async () => {
    const j = new SqlJournal(); const locks = await Promise.all([j.acquire(CONFIG.accountId), j.acquire(CONFIG.accountId)]); const one = locks.find(Boolean)!;
    expect(locks.filter(Boolean)).toHaveLength(1); await j.release({ ...one, owner: 'wrong' }); expect(await j.acquire(CONFIG.accountId)).toBeNull();
    await query("UPDATE app_settings SET value=jsonb_set(value,'{expires}','0'::jsonb) WHERE key=$1", [one.key]);
    const replacement = (await j.acquire(CONFIG.accountId))!; expect(replacement.owner).not.toBe(one.owner);
    await expect(j.save(one, initialState())).rejects.toThrow('lock_lost'); await j.release(one); expect(await j.acquire(CONFIG.accountId)).toBeNull(); await j.release(replacement);
  });
  it('leaves the account lock available for protection while reading slow candles', async () => {
    const j = new SqlJournal(); await seed(j, ['AAA-EUR'], false); const { port } = makePort();
    vi.mocked(port.candles).mockImplementation(async () => {
      const protectionLease = await j.acquire(CONFIG.accountId);
      expect(protectionLease).not.toBeNull(); await j.release(protectionLease!); return [];
    });
    await cycle(port, j, ['AAA-EUR'], () => NOW);
    expect(port.candles).toHaveBeenCalled(); expect(port.submit).not.toHaveBeenCalled();
  });
  it('arms the deadline before the sole entry, persists signal consumption across runner restarts', async () => {
    const j = new SqlJournal(); await seed(j, ['AAA-EUR', 'BBB-EUR']); const { port } = makePort();
    const result = await cycle(port, j, ['AAA-EUR', 'BBB-EUR'], () => NOW);
    expect(result.status).toBe('submitted'); expect(port.submit).toHaveBeenCalledOnce();
    expect(vi.mocked(port.armCancellation).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(port.submit).mock.invocationCallOrder[0]);
    await cycle(port, new SqlJournal(), ['AAA-EUR'], () => NOW); expect(port.submit).toHaveBeenCalledOnce();
    const lease = (await j.acquire(CONFIG.accountId))!; expect((await j.decision(lease, result.intent!.key))?.signalId).toBe(signal().id); await j.release(lease);
  });
  it('records network uncertainty, looks up the same key, and still protects other positions', async () => {
    const j = new SqlJournal(); await seed(j); const { port, a } = makePort();
    vi.mocked(port.submit).mockRejectedValueOnce(new Error('network_timeout'));
    const first = await cycle(port, j, ['AAA-EUR'], () => NOW); expect(first.status).toBe('unknown');
    vi.mocked(port.lookup).mockResolvedValue({ order: null, authoritative: false });
    a.positions = [position('BBB-EUR')];
    const second = await cycle(port, j, ['AAA-EUR'], () => NOW);
    expect(second.blocks.some(b => b.reason === 'entry_reservation_unknown')).toBe(true); expect(port.submit).toHaveBeenCalledOnce(); expect(port.ensureProtection).toHaveBeenCalled();
    expect(port.lookup).toHaveBeenCalledWith(first.intent!.key, expect.any(Object));
  });
  it('resolves a late source acknowledgment without ever resending the old signal', async () => {
    const j = new SqlJournal(); await seed(j); const { port } = makePort(); vi.mocked(port.submit).mockRejectedValueOnce(new Error('timeout'));
    const first = await cycle(port, j, ['AAA-EUR'], () => NOW);
    const accepted = { ...order(), clientKey: first.intent!.key };
    vi.mocked(port.lookup).mockResolvedValue({ order: accepted, authoritative: true });
    await cycle(port, new SqlJournal(), ['AAA-EUR'], () => NOW); expect(port.submit).toHaveBeenCalledOnce();
    const lease = (await j.acquire(CONFIG.accountId))!; expect(await j.unresolved(lease)).toEqual([]); await j.release(lease);
  });
  it('does not let a failed unknown-order lookup prevent other position protection', async () => {
    const j = new SqlJournal(); await seed(j); const { port, a } = makePort(); vi.mocked(port.submit).mockRejectedValueOnce(new Error('timeout'));
    await cycle(port, j, ['AAA-EUR'], () => NOW); a.positions = [position('BBB-EUR')];
    vi.mocked(port.lookup).mockRejectedValue(new Error('lookup_timeout'));
    await cycle(port, j, ['AAA-EUR'], () => NOW); expect(port.ensureProtection).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'BBB-EUR' }), expect.any(Object)); expect(port.submit).toHaveBeenCalledOnce();
  });
  it('gives exits priority while entries are paused and waits for cancellation/reservations', async () => {
    const j = new SqlJournal(); await seed(j, ['BBB-EUR'], false); const { port, a } = makePort(); a.positions = [position()];
    vi.mocked(port.quotes).mockImplementation(async symbols => symbols.map(s => ({ ...quote(s), bid: s === 'AAA-EUR' ? '97' : '99.99' })));
    a.positions[0].available = '0'; a.positions[0].reserved = '1';
    expect((await cycle(port, j, ['BBB-EUR'], () => NOW)).blocks.some(b => b.reason === 'exit_cancellation_pending')).toBe(true); expect(port.submit).not.toHaveBeenCalled();
    a.positions[0].available = '1'; a.positions[0].reserved = '0';
    const result = await cycle(port, j, ['BBB-EUR'], () => NOW); expect(result.intent).toMatchObject({ side: 'sell', reason: 'stop', quantity: '1' }); expect(port.armCancellation).not.toHaveBeenCalled();
  });
  it('cancels a partial entry after 60 seconds independently and protects its confirmed quantity', async () => {
    const j = new SqlJournal(), { port, a } = makePort();
    const intent = planBuy(a, signal(), instrument(), quote(), evaluateRisk(initialState().risk, [], a.equityHistory, true, NOW), NOW).intent!;
    const lease = (await j.acquire(CONFIG.accountId))!; await j.begin(lease, intent, NOW); await j.release(lease);
    const partial = { ...order(), clientKey: intent.key, status: 'partial' as const, filledQuantity: '0.4', averageFillPrice: '100' };
    const done = { ...partial, status: 'cancelled' as const };
    vi.mocked(port.lookup).mockResolvedValueOnce({ order: partial, authoritative: true }).mockResolvedValueOnce({ order: done, authoritative: true });
    a.positions = [{ ...position(), quantity: '0.4', available: '0.4' }];
    expect(await cancelDeadline(port, j, intent.key, NOW + 59)).toMatchObject({ status: 'not_due', retryAt: NOW + 60 });
    expect(await cancelDeadline(port, j, intent.key, NOW + 60)).toMatchObject({ status: 'cancelled', retryAt: null });
    expect(port.cancelRemainder).toHaveBeenCalledWith(partial.id, expect.any(Object)); expect(port.ensureProtection).toHaveBeenCalledWith(expect.objectContaining({ quantity: '0.4' }), expect.any(Object)); expect(port.submit).not.toHaveBeenCalled();
  });
  it.each(['unsupported', 'timeout'])('keeps protecting partial fills when cancellation is %s', async mode => {
    const j = new SqlJournal(), { port, a } = makePort();
    const intent = planBuy(a, signal(), instrument(), quote(), evaluateRisk(initialState().risk, [], a.equityHistory, true, NOW), NOW).intent!;
    const lease = (await j.acquire(CONFIG.accountId))!; await j.begin(lease, intent, NOW); await j.release(lease);
    const partial = { ...order(), clientKey: intent.key, status: 'partial' as const, filledQuantity: '0.4', averageFillPrice: '100' };
    vi.mocked(port.lookup).mockResolvedValue({ order: partial, authoritative: true });
    a.positions = [{ ...position(), quantity: '0.4', available: '0.4' }];
    if (mode === 'unsupported') vi.mocked(port.capabilities).mockResolvedValue({
      idempotentOrders: true, fencedWrites: false, attachedProtection: true, coordinatedExits: false, cancelRemainder: false, cancellationTimer: true });
    else vi.mocked(port.cancelRemainder).mockRejectedValueOnce(new Error('network_timeout'));
    expect(await cancelDeadline(port, j, intent.key, NOW + 60)).toMatchObject({
      status: mode === 'unsupported' ? 'blocked' : 'unknown', retryAt: NOW + (mode === 'unsupported' ? 120 : 65) });
    expect(port.ensureProtection).toHaveBeenCalledWith(expect.objectContaining({ quantity: '0.4' }), expect.any(Object));
    expect(port.cancelRemainder).toHaveBeenCalledTimes(mode === 'unsupported' ? 0 : 1);
    expect(port.submit).not.toHaveBeenCalled();
  });
  it('does not settle a deadline using a different source order returned after cancellation', async () => {
    const j = new SqlJournal(), { port, a } = makePort();
    const intent = planBuy(a, signal(), instrument(), quote(), evaluateRisk(initialState().risk, [], a.equityHistory, true, NOW), NOW).intent!;
    const lease = (await j.acquire(CONFIG.accountId))!; await j.begin(lease, intent, NOW); await j.release(lease);
    const partial = { ...order(), clientKey: intent.key, status: 'partial' as const, filledQuantity: '0.4' };
    vi.mocked(port.lookup).mockResolvedValueOnce({ order: partial, authoritative: true })
      .mockResolvedValueOnce({ order: { ...partial, id: 'different-order', status: 'cancelled' }, authoritative: true });
    await expect(cancelDeadline(port, j, intent.key, NOW + 60)).rejects.toThrow('deadline_order_mismatch');
    const next = (await j.acquire(CONFIG.accountId))!;
    expect((await j.decision(next, intent.key))?.status).toBe('attempting'); await j.release(next);
  });
  it('finishes a filled-order deadline through live protection data even when entry accounting cannot be read', async () => {
    const j = new SqlJournal(), { port, a } = makePort();
    const intent = planBuy(a, signal(), instrument(), quote(), evaluateRisk(initialState().risk, [], a.equityHistory, true, NOW), NOW).intent!;
    const lease = (await j.acquire(CONFIG.accountId))!; await j.begin(lease, intent, NOW); await j.release(lease);
    const filled = { ...order(), clientKey: intent.key, status: 'filled' as const, filledQuantity: '0.4' };
    vi.mocked(port.lookup).mockResolvedValue({ order: filled, authoritative: true });
    a.positions = [{ ...position(), quantity: '0.4', available: '0.4' }];
    vi.mocked(port.account).mockImplementation(async options => {
      if (!options?.protectionOnly) throw new Error('managed_exit_fill_mismatch');
      return structuredClone(a);
    });
    expect(await cancelDeadline(port, j, intent.key, NOW + 60)).toMatchObject({ status: 'filled', retryAt: null });
    expect(port.ensureProtection).toHaveBeenCalledOnce();
    expect(port.cancelRemainder).not.toHaveBeenCalled(); expect(port.submit).not.toHaveBeenCalled();
  });
});
describe('daily read-only reporting', () => {
  it('preserves the last good snapshot on failure and waits for the next reporting retry', async () => {
    const j = new SqlJournal(); const lease = (await j.acquire(CONFIG.accountId))!;
    const state = initialState(); state.lastSuccessfulReport = { id: 'prior', sourceAt: NOW - 86400 }; await j.save(lease, state); await j.release(lease);
    const nineBerlin = Date.parse('2026-09-27T07:00:00Z') / 1000;
    expect(await dailyReport(null, j, nineBerlin)).toMatchObject({ status: 'blocked' });
    expect(await dailyReport(null, j, nineBerlin + 120)).toMatchObject({ status: 'retry_wait', retryAt: nineBerlin + 300 });
    const l = (await j.acquire(CONFIG.accountId))!; expect((await j.state(l)).lastSuccessfulReport?.id).toBe('prior'); await j.release(l);
    expect(await dailyReport(null, j, nineBerlin + 3600)).toMatchObject({ status: 'blocked' });
    expect(await dailyReport(null, j, nineBerlin - 1)).toMatchObject({ status: 'not_due' });
  });
  it('combines Sunday review with daily report and exposes archive gaps instead of old results', () => {
    const sunday = Date.parse('2026-09-27T07:00:00Z') / 1000;
    const report = buildReport(account(), sunday); expect(report.weekly).not.toBeNull();
    expect(report.weekly?.current.coverageComplete).toBe(false); expect(report.weekly?.current.realizedNetPnlEur).toBeNull();
    expect(report.weekly?.current.from).toBe(report.weekly?.previous.until);
  });
});
describe('public candle contract and durable timer', () => {
  it('requires an authenticated durable timer acknowledgment before permitting submission', async () => {
    vi.stubEnv('EXECUTION_DEADLINE_URL', 'https://worker.test/schedule'); vi.stubEnv('EXECUTION_SCHEDULER_TOKEN', 'test-secret');
    const fetcher = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => Response.json({ scheduled: true, expiresAt: NOW + 60 }));
    await scheduleCancellation('a'.repeat(64), NOW + 60, fetcher);
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer test-secret' });
    fetcher.mockResolvedValueOnce(Response.json({ scheduled: true, expiresAt: NOW + 600 }));
    await expect(scheduleCancellation('a'.repeat(64), NOW + 60, fetcher)).rejects.toThrow('deadline_not_acknowledged');
  });
  it('requests all 1000 wallet-source bars and never accepts a truncated warmup', async () => {
    const bars = Array.from({ length: 1000 }, (_, i) => candle(i));
    const provider = vi.fn(async () => bars);
    expect(await loadCandles('AAA-EUR', 900000, null, provider)).toHaveLength(1000);
    expect(provider).toHaveBeenCalledWith({ symbol: 'AAA-EUR', start: 0, end: 900000, timeframeSeconds: 900 });
    provider.mockResolvedValueOnce(bars.slice(1));
    await expect(loadCandles('AAA-EUR', 900000, null, provider)).rejects.toThrow('1000');
    await expect(loadCandles('AAA-EUR', 900000, null)).rejects.toThrow('wallet_candle_provider_missing');
  });
  it('keeps deadline retries durable and never extends an existing deadline', async () => {
    const data = new Map<string, unknown>();
    const storage = { get: vi.fn(async (k: string) => data.get(k)), put: vi.fn(async (k: string, v: unknown) => { data.set(k, v); }), setAlarm: vi.fn(async () => undefined), delete: vi.fn(async (k: string) => { data.delete(k); }) };
    const timer = new OrderDeadline({ storage }, { EXECUTION_SCHEDULER_TOKEN: 'test' });
    await timer.fetch(new Request('https://deadline.internal/schedule', { method: 'POST', body: JSON.stringify({ key: 'a'.repeat(64), expiresAt: NOW + 60 }) }));
    await timer.fetch(new Request('https://deadline.internal/schedule', { method: 'POST', body: JSON.stringify({ key: 'a'.repeat(64), expiresAt: NOW + 600 }) }));
    expect(data.get('job')).toMatchObject({ expiresAt: NOW + 60 });
    const fetcher = vi.fn(async () => Response.json({ status: 'cancellation_pending', retryAt: NOW + 65 })); vi.stubGlobal('fetch', fetcher);
    await timer.alarm(); expect(data.has('job')).toBe(true); expect(storage.setAlarm).toHaveBeenCalledTimes(3);
    fetcher.mockResolvedValueOnce(Response.json({ status: 'cancelled', retryAt: null })); await timer.alarm(); expect(data.has('job')).toBe(false);
    expect((await worker.fetch(new Request('https://worker.test/schedule', { method: 'POST' }), { EXECUTION_SCHEDULER_TOKEN: 'test' })).status).toBe(401);
  });
  it.each([401, 302])('retains a deadline on HTTP %i without following redirects or parsing an error page', async status => {
    vi.useFakeTimers();
    const data = new Map<string, unknown>([['job', { key: 'b'.repeat(64), expiresAt: NOW }]]);
    const storage = { get: vi.fn(async (k: string) => data.get(k)), setAlarm: vi.fn(async () => undefined), delete: vi.fn(async (k: string) => { data.delete(k); }) };
    const fetcher = vi.fn(async (_input: string | URL | Request, options?: RequestInit) => {
      if (options?.redirect !== 'manual') throw new TypeError('unsupported_redirect_mode');
      return new Response('Host rejected request', { status, headers: status === 302 ? { Location: 'https://different.test/' } : {} });
    });
    vi.stubGlobal('fetch', fetcher);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await new OrderDeadline({ storage }, { EXECUTION_SCHEDULER_TOKEN: 'test-secret' }).alarm();
    expect(data.has('job')).toBe(true); expect(storage.setAlarm).toHaveBeenCalledOnce(); expect(storage.delete).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(JSON.parse(warning.mock.calls[0][0])).toMatchObject({ type: 'execution.v1.deadline_retry', reason: `scheduler_http_${status}` });
    expect(JSON.stringify(warning.mock.calls)).not.toContain('test-secret');
  });
});


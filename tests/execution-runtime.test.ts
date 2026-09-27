import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, query } from '../src/lib/db';
import { SqlJournal, initialState } from '../src/lib/execution/v1/journal';
import { configuredSymbols } from '../src/lib/execution/v1/host';
import { configuredWatchlist, setSetting } from '../src/lib/services';
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
    capabilities: vi.fn(async () => ({ idempotentOrders: true, fencedWrites: true, attachedProtection: true, coordinatedExits: true, cancelRemainder: true, cancellationTimer: true })),
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
beforeEach(async () => {
  await closeDatabase(); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('VERCEL', ''); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://');
});
afterEach(async () => { vi.useRealTimers(); await closeDatabase(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('durable SQL ownership and orchestration', () => {
  it('uses the dashboard watchlist including its defaults and preserves an explicitly empty selection', async () => {
    expect(await configuredSymbols()).toEqual(await configuredWatchlist());
    expect(await configuredSymbols()).toEqual(['BTC-EUR', 'ETH-EUR', 'SOL-EUR']);
    await setSetting('watchlist', ['SOL-EUR', 'SOL-EUR', 'BTC-USD']);
    expect(await configuredSymbols()).toEqual(['SOL-EUR']);
    await setSetting('watchlist', []); expect(await configuredSymbols()).toEqual([]);
  });
  it('grants one concurrent lock and fences stale owners without releasing another owner', async () => {
    const j = new SqlJournal(); const locks = await Promise.all([j.acquire(CONFIG.accountId), j.acquire(CONFIG.accountId)]); const one = locks.find(Boolean)!;
    expect(locks.filter(Boolean)).toHaveLength(1); await j.release({ ...one, owner: 'wrong' }); expect(await j.acquire(CONFIG.accountId)).toBeNull();
    await query("UPDATE app_settings SET value=jsonb_set(value,'{expires}','0'::jsonb) WHERE key=$1", [one.key]);
    const replacement = (await j.acquire(CONFIG.accountId))!; expect(replacement.owner).not.toBe(one.owner);
    await expect(j.save(one, initialState())).rejects.toThrow('lock_lost'); await j.release(one); expect(await j.acquire(CONFIG.accountId)).toBeNull(); await j.release(replacement);
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
});
describe('daily read-only reporting', () => {
  it('preserves the last good snapshot on failure and deduplicates the Berlin day', async () => {
    const j = new SqlJournal(); const lease = (await j.acquire(CONFIG.accountId))!;
    const state = initialState(); state.lastSuccessfulReport = { id: 'prior', sourceAt: NOW - 86400 }; await j.save(lease, state); await j.release(lease);
    const nineBerlin = Date.parse('2026-09-27T07:00:00Z') / 1000;
    expect(await dailyReport(null, j, nineBerlin)).toMatchObject({ status: 'blocked' });
    expect(await dailyReport(null, j, nineBerlin + 120)).toMatchObject({ status: 'already_recorded' });
    const l = (await j.acquire(CONFIG.accountId))!; expect((await j.state(l)).lastSuccessfulReport?.id).toBe('prior'); await j.release(l);
    expect(await dailyReport(null, j, nineBerlin + 3600)).toMatchObject({ status: 'not_due' });
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
  it('requests all 1000 bars, uses milliseconds, and never accepts a truncated warmup', async () => {
    const bars = Array.from({ length: 1000 }, (_, i) => candle(i));
    const data = bars.map(c => ({ start: c.openTime * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ data, metadata: { region: 'EEA', timestamp: 900000000 } }));
    expect(await loadCandles('AAA-EUR', 900000, null, fetcher)).toHaveLength(1000);
    expect(String(fetcher.mock.calls[0][0])).toContain('since=0&until=900000000&region=EEA');
    fetcher.mockResolvedValueOnce(Response.json({ data: data.slice(1), metadata: { region: 'EEA', timestamp: 900000000 } }));
    await expect(loadCandles('AAA-EUR', 900000, null, fetcher)).rejects.toThrow('1000');
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

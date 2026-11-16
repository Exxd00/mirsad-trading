import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderDeadline } from '../automation/execution-v1-worker.mjs';

const NOW = 1794800000, key = 'a'.repeat(64), secret = 'isolated-worker-token';
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW * 1000); vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture(result: unknown, status = 200) {
  const data = new Map<string, unknown>([['job', { key, expiresAt: NOW }]]); let alarm: number | null = null;
  const storage = { get: vi.fn(async (k: string) => data.get(k)), setAlarm: vi.fn(async (at: number) => { alarm = at; }),
    put: vi.fn(async (k: string, v: unknown) => { data.set(k, v); }),
    delete: vi.fn(async (k: string) => { data.delete(k); }) };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(result, { status })); vi.stubGlobal('fetch', fetcher);
  const env = { EXECUTION_SCHEDULER_TOKEN: secret };
  return { data, storage, fetcher, timer: new OrderDeadline({ storage }, env), restart: () => new OrderDeadline({ storage }, env), alarm: () => alarm };
}
describe('Worker deadline wakeups require authoritative terminal acknowledgment', () => {
  it.each(['filled', 'cancelled', 'rejected', 'expired', 'absent'])('removes only the explicit %s terminal contract', async status => {
    const f = fixture({ status, retryAt: null }); await f.timer.alarm();
    expect(f.data.has('job')).toBe(false); expect(f.storage.delete).toHaveBeenCalledOnce(); expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.storage.setAlarm).toHaveBeenCalledWith((NOW + 5) * 1000);
  });
  it.each([
    { status: 'blocked', reason: 'wallet_execution_transport_missing' },
    { status: 'blocked', reason: 'invalid_order_connection' }, { status: 'unknown' }, { status: 'unavailable' },
    { status: 'error' }, { status: 'not_an_entry', retryAt: null }, { status: 'invented-terminal' }, {},
    { status: 'filled' }, { status: 'cancelled', retryAt: null, reason: 'source_unavailable' },
  ])('retains an unproven result %j across eviction without a second dispatch in that alarm', async result => {
    const f = fixture(result, result.status === 'blocked' ? 409 : 200); await f.timer.alarm();
    expect(f.data.get('job')).toEqual({ key, expiresAt: NOW }); expect(f.storage.delete).not.toHaveBeenCalled();
    expect(f.alarm()).toBe((NOW + (result.status === 'not_an_entry' || result.reason === 'wallet_execution_transport_missing' ? 60 : 5)) * 1000);
    expect(f.fetcher).toHaveBeenCalledOnce();
    f.fetcher.mockResolvedValueOnce(Response.json({ status: 'cancelled', retryAt: null })); await f.restart().alarm();
    expect(f.data.has('job')).toBe(false); expect(f.fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of f.fetcher.mock.calls) {
      expect(String(url)).toBe('https://mirsad-trading.vercel.app/api/execution/deadline');
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual', body: JSON.stringify({ key }) });
    }
  });
  it.each([undefined, null, 0, -1, '1794800060', NOW + 0.5, Number.MAX_SAFE_INTEGER, NOW + 61])('bounds unusable retryAt=%s without removing the job', async retryAt => {
    const f = fixture({ status: 'unknown', retryAt }); await f.timer.alarm();
    expect(f.data.has('job')).toBe(true); expect(f.alarm()).toBe((NOW + 5) * 1000); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each([[NOW + 5, 5], [NOW + 60, 60], [NOW - 1, 1]])('honors the bounded retry %s at +%s seconds', async (retryAt, seconds) => {
    const f = fixture({ status: 'cancellation_pending', retryAt }); await f.timer.alarm();
    expect(f.data.has('job')).toBe(true); expect(f.alarm()).toBe((NOW + seconds) * 1000);
  });
  it('persists the next wake before external I/O and retains it after a lost acknowledgment', async () => {
    const f = fixture(null);
    f.fetcher.mockImplementationOnce(async () => {
      expect(f.alarm()).toBe((NOW + 5) * 1000); expect(f.data.has('job')).toBe(true);
      throw new Error('connection lost after the host may have received this request');
    });
    await f.timer.alarm();
    expect(f.storage.setAlarm.mock.invocationCallOrder[0]).toBeLessThan(f.fetcher.mock.invocationCallOrder[0]);
    expect(f.storage.delete).not.toHaveBeenCalled(); expect(f.alarm()).toBe((NOW + 5) * 1000); expect(f.fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves the original deadline when schedule fetch interleaves with an alarm awaiting acknowledgment', async () => {
    const f = fixture(null); let acknowledge!: (r: Response) => void;
    f.fetcher.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
    const first = f.timer.alarm(); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    await f.timer.fetch(new Request('https://deadline.internal/schedule', { method: 'POST', body: JSON.stringify({ key, expiresAt: NOW + 600 }) }));
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.data.get('job')).toEqual({ key, expiresAt: NOW });
    acknowledge(Response.json({ status: 'unknown', retryAt: NOW + 5 })); await first;
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.data.has('job')).toBe(true);
    f.fetcher.mockResolvedValueOnce(Response.json({ status: 'cancelled', retryAt: null })); await f.timer.alarm();
    expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.data.has('job')).toBe(false);
  });
  it.each([undefined, 'retired-account'])('quarantines an unscoped or foreign protection watch without adopting or deleting it', async accountId => {
    const original = { kind: 'protection', ...(accountId === undefined ? {} : { accountId }) }, f = fixture(null);
    f.data.set('job', original);
    const storage = { ...f.storage, put: vi.fn(), getAlarm: vi.fn(async () => null) };
    const timer = new OrderDeadline({ storage }, { EXECUTION_SCHEDULER_TOKEN: secret });
    await timer.alarm(); expect(f.data.get('job')).toEqual(original); expect(f.fetcher).not.toHaveBeenCalled();
    expect(storage.setAlarm).not.toHaveBeenCalled(); expect(storage.delete).not.toHaveBeenCalled();
    expect(JSON.parse(vi.mocked(console.warn).mock.calls[0][0])).toEqual({ type: 'execution.v1.protection_quarantined', reason: 'protection_account_unverified' });
    const response = await timer.fetch(new Request('https://deadline.internal/watch', { method: 'POST', body: JSON.stringify({ kind: 'protection' }) }));
    expect(response.status).toBe(409); expect(storage.put).not.toHaveBeenCalled(); expect(f.data.get('job')).toEqual(original);
  });
});

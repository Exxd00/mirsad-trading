import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../automation/discovery-worker.mjs';

const token = 'independent-discovery-test-secret';
const env = { DISCOVERY_SCHEDULER_TOKEN: token, EXECUTION_SCHEDULER_TOKEN: 'never-use-this-financial-secret' };

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('independent paper discovery scheduler', () => {
  it('calls only the fixed discovery endpoint once with the independent credential', async () => {
    const fetcher = vi.fn(async (_url: string, _options: RequestInit) => Response.json({ status: 'ok', privateDetail: 'do-not-log' }));
    vi.stubGlobal('fetch', fetcher);
    expect(await worker.scheduled({}, env)).toEqual({ status: 'accepted' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://mirsad-trading.vercel.app/api/discovery/tick', {
      method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}',
    });
    expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: 'discovery.tick', status: 'accepted' }));
  });

  it.each([undefined, '', 'bad\r\ncredential', 'has whitespace'])('does not fall back to a financial credential when the discovery credential is invalid', async value => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect(await worker.scheduled({}, { ...env, DISCOVERY_SCHEDULER_TOKEN: value })).toEqual({ status: 'not_configured' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([301, 302, 307, 308])('rejects HTTP %s without forwarding a credential to the redirect target', async status => {
    const fetcher = vi.fn(async () => new Response('private response', { status, headers: { Location: 'https://untrusted.example/collect' } }));
    vi.stubGlobal('fetch', fetcher);
    expect(await worker.scheduled({}, env)).toEqual({ status: 'redirect_rejected' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: 'discovery.tick', status: 'redirect_rejected' }));
  });

  it.each([[409, 'busy'], [401, 'unauthorized'], [403, 'unauthorized'], [429, 'rate_limited'], [500, 'upstream_error'], [503, 'upstream_error']])('defers HTTP %s to the next scheduled invocation without a retry burst', async (code, status) => {
    const fetcher = vi.fn(async () => new Response(`private:${token}`, { status: code as number }));
    vi.stubGlobal('fetch', fetcher);
    expect(await worker.scheduled({}, env)).toEqual({ status });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: 'discovery.tick', status }));
  });

  it('aborts a slow request at 20 seconds and clears its timer', async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    const fetcher = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = options.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(new Error(`must-not-log:${token}`)), { once: true });
    }));
    vi.stubGlobal('fetch', fetcher);
    const run = worker.scheduled({}, env);
    await vi.advanceTimersByTimeAsync(19999); expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await run).toEqual({ status: 'timeout' });
    expect(signal?.aborted).toBe(true); expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: 'discovery.tick', status: 'timeout' }));
  });

  it('never exposes a rejected request error and permits the next scheduled minute', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockRejectedValueOnce(new Error(`Authorization: Bearer ${token}`)).mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await worker.scheduled({}, env)).toEqual({ status: 'network_error' });
    expect(vi.getTimerCount()).toBe(0); expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60000); expect(fetcher).toHaveBeenCalledOnce();
    expect(await worker.scheduled({}, env)).toEqual({ status: 'accepted' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(console.log).toHaveBeenNthCalledWith(1, JSON.stringify({ type: 'discovery.tick', status: 'network_error' }));
    expect(console.log).toHaveBeenNthCalledWith(2, JSON.stringify({ type: 'discovery.tick', status: 'accepted' }));
  });

  it('exposes a public paper-only health check without dispatching any request', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const response = await worker.fetch(new Request('https://discovery.example/health'));
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'ok', mode: 'paper', financialMutations: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['/tick', '/api/discovery/tick', '/api/execution/tick', '/watch-protection', '/schedule'])('offers no public dispatch control at %s', async path => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const response = await worker.fetch(new Request(`https://discovery.example${path}`, { method: 'POST' }));
    expect(response.status).toBe(404); expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects health writes without executing a scheduled run', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const response = await worker.fetch(new Request('https://discovery.example/health', { method: 'POST' }));
    expect(response.status).toBe(405); expect(response.headers.get('allow')).toBe('GET'); expect(fetcher).not.toHaveBeenCalled();
  });
});

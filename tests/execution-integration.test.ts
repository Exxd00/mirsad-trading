import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError } from '../src/lib/auth';
import { GET, POST } from '../src/app/api/execution/[...action]/route';
import { GET as legacyGet, POST as legacyPost } from '../src/app/api/education/[...action]/route';
import { executionReport, runExecution } from '../src/lib/execution/service';
import retiredWorker from '../automation/retired-scheduler.mjs';

const auth = vi.hoisted(() => ({ requireSession: vi.fn(), requireMutation: vi.fn(), refreshSessionCookie: vi.fn() }));
vi.mock('../src/lib/auth', async original => ({ ...(await original<typeof import('../src/lib/auth')>()), ...auth }));
const context = (action: string) => ({ params: Promise.resolve({ action: [action] }) });
const request = (action: string, data: unknown = {}) => new Request(`https://mirsad.test/api/execution/${action}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});
beforeEach(() => {
  vi.clearAllMocks();
  auth.requireSession.mockResolvedValue({ id: 'test-session' });
  auth.requireMutation.mockResolvedValue({ id: 'test-session' });
  auth.refreshSessionCookie.mockResolvedValue('test-session=renewed');
  vi.stubEnv('VERCEL_ENV', 'production');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('native host integration', () => {
  it('does not create balances, orders, performance or provider traffic without an adapter', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect(executionReport()).toMatchObject({ mode: 'execution-core', enabled: false,
      account_id: null, available_eur: null, positions: null, orders: null, performance: null });
    expect(await runExecution()).toEqual({ status: 'disabled', reason: 'adapter_not_configured' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('authenticates reports, renews the session and prevents caching', async () => {
    const response = await GET(new Request('https://mirsad.test/api/execution/report'), context('report'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('set-cookie')).toBe('test-session=renewed');
    expect(await response.json()).toMatchObject({ adapter_configured: false, source_at: null });
    auth.requireSession.mockRejectedValueOnce(new AuthError(401, 'AUTH_REQUIRED', 'Session required'));
    expect((await GET(new Request('https://mirsad.test/api/execution/report'), context('report'))).status).toBe(401);
  });
  it('enforces mutation authorization before accepting run requests', async () => {
    auth.requireMutation.mockRejectedValueOnce(new AuthError(403, 'CSRF_REQUIRED', 'CSRF required'));
    expect((await POST(request('run'), context('run'))).status).toBe(403);
  });
  it('returns an explicit unavailable-integration result and cannot be enabled from HTTP', async () => {
    const response = await POST(request('run'), context('run'));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: 'disabled', reason: 'adapter_not_configured' });
    expect((await POST(request('run', { enabled: true }), context('run'))).status).toBe(400);
    expect((await POST(request('settings', { enabled: true }), context('settings'))).status).toBe(404);
    vi.stubEnv('VERCEL_ENV', 'preview');
    expect((await POST(request('run'), context('run'))).status).toBe(403);
  });
  it.each(['tick', 'setup', 'settings', 'run'])('retires legacy %s requests without invoking a provider', async action => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const response = await legacyPost(request(action, { enabled: true }), context(action));
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ code: 'LEGACY_ENGINE_REMOVED' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('retires the legacy report and Cloudflare entry points', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect((await legacyGet(new Request('https://mirsad.test/api/education/report'))).status).toBe(410);
    expect(await retiredWorker.scheduled()).toEqual({ status: 'retired' });
    expect((await retiredWorker.fetch()).status).toBe(410);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

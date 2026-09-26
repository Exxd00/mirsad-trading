import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError } from '../src/lib/auth';
import { GET, POST } from '../src/app/api/execution/[...action]/route';
import { GET as legacyGet, POST as legacyPost } from '../src/app/api/education/[...action]/route';
import { executionReport, runExecution } from '../src/lib/execution/service';
import { EDUCATION_STORAGE_KEY, educationSnapshot, readEducationAccount } from '../src/lib/execution/education-account';
import retiredWorker from '../automation/retired-scheduler.mjs';

const auth = vi.hoisted(() => ({ requireSession: vi.fn(), requireMutation: vi.fn(), refreshSessionCookie: vi.fn() }));
const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/lib/auth', async original => ({ ...(await original<typeof import('../src/lib/auth')>()), ...auth }));
vi.mock('../src/lib/db', async original => ({ ...(await original<typeof import('../src/lib/db')>()), ...db }));
const storedAccount = () => ({ version: 1 as const, updatedAt: new Date().toISOString(),
  balances: [{ currency: 'EUR', total: '97.43', available: '87.43', reserved: '10' }], positions: [], orders: [],
});
const context = (action: string) => ({ params: Promise.resolve({ action: [action] }) });
const request = (action: string, data: unknown = {}) => new Request(`https://mirsad.test/api/execution/${action}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});
beforeEach(() => {
  vi.clearAllMocks();
  db.query.mockResolvedValue({ rows: [], rowCount: 0 });
  auth.requireSession.mockResolvedValue({ id: 'test-session' });
  auth.requireMutation.mockResolvedValue({ id: 'test-session' });
  auth.refreshSessionCookie.mockResolvedValue('test-session=renewed');
  vi.stubEnv('VERCEL_ENV', 'production');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('native host integration', () => {
  it('reads only the existing educational account without seeding balances or calling a broker', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect(await executionReport()).toMatchObject({ mode: 'execution-core', enabled: false,
      account_id: 'mirsad-education', account_source_configured: true, account_connected: false,
      available_eur: null, positions: null, orders: null, performance: null });
    expect(await runExecution()).toEqual({ status: 'disabled', reason: 'education_account_not_initialized' });
    expect(db.query.mock.calls.every(([sql, params]) => sql === 'SELECT value FROM app_settings WHERE key=$1' && params[0] === EDUCATION_STORAGE_KEY)).toBe(true);
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
    expect(await response.json()).toMatchObject({ status: 'disabled', reason: 'education_account_not_initialized' });
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
  it('returns exact stored balances through the authenticated route and waits for a source signal', async () => {
    const account = storedAccount(), before = structuredClone(account); db.query.mockResolvedValue({ rows: [{ value: account }], rowCount: 1 });
    const response = await GET(new Request('https://mirsad.test/api/execution/report'), context('report'));
    const report = await response.json();
    expect(report).toMatchObject({ account_connected: true, account_id: 'mirsad-education', available_eur: '87.43',
      balances: account.balances, execution_ready: false, signal_configured: false });
    expect(await runExecution()).toMatchObject({ status: 'disabled', reason: 'no_entry_signal', account_id: 'mirsad-education' });
    expect(account).toEqual(before);
  });
  it('preserves source timestamps instead of pretending an old snapshot is fresh', async () => {
    const account = { ...storedAccount(), updatedAt: '2020-01-01T00:00:00.000Z' };
    db.query.mockResolvedValue({ rows: [{ value: account }], rowCount: 1 });
    expect(await runExecution()).toMatchObject({ status: 'disabled', reason: 'stale_source' });
    expect((await executionReport()).source_at).toBe(Date.parse(account.updatedAt) / 1000);
  });
  it('preserves old position levels without automatically adopting them into the new engine', async () => {
    const now = new Date().toISOString();
    const account = { ...storedAccount(), balances: [...storedAccount().balances,
      { currency: 'BTC', total: '0.02', available: '0.01', reserved: '0.01' }],
      positions: [{ id: 'old-position', symbol: 'BTC-EUR', quantity: '0.02', entryPrice: '50000', stopPrice: '49000', targetPrice: '52000' }],
      portfolioValuation: { prices: { BTC: { bid: '48000', quoteAt: now } } },
    };
    const snapshot = educationSnapshot(account);
    expect(snapshot?.positions[0]).toMatchObject({ id: 'old-position', managed: false, available_quantity: '0.01', stop_price: '49000', target_price: '52000' });
    db.query.mockResolvedValue({ rows: [{ value: account }], rowCount: 1 });
    expect(await runExecution()).toMatchObject({ status: 'disabled', reason: 'no_entry_signal' });
    expect(educationSnapshot({ ...account, portfolioValuation: undefined })).toBeNull();
  });
  it('rejects inconsistent balances and propagates database errors instead of displaying invented zeroes', async () => {
    const account = storedAccount(); account.balances[0].available = '100';
    db.query.mockResolvedValueOnce({ rows: [{ value: account }], rowCount: 1 });
    await expect(readEducationAccount()).rejects.toThrow();
    db.query.mockRejectedValueOnce(new Error('database_unavailable'));
    expect((await GET(new Request('https://mirsad.test/api/execution/report'), context('report'))).status).toBe(503);
  });
});

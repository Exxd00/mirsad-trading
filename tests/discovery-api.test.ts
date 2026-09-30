import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { closeDatabase, ensureSchema, query } from '../src/lib/db';
import { hashPassword, issueLoginCsrf, login, sessionCookieName } from '../src/lib/auth';
import { GET, POST } from '../src/app/api/discovery/[...action]/route';

const service = vi.hoisted(() => ({ discoveryReport: vi.fn(), runDiscovery: vi.fn() }));
vi.mock('../src/lib/discovery/service', () => service);
const token = 'discovery-only-test-token-long-enough-32';
const financialToken = 'financial-only-test-token-long-enough-32';
const password = 'isolated-discovery-password-A8!';
const context = (action: string) => ({ params: Promise.resolve({ action: [action] }) });
const request = (action: string, body: unknown = {}, bearer?: string, headers: Record<string, string> = {}) => new Request(`http://localhost:3000/api/discovery/${action}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...headers }, body: JSON.stringify(body),
});
async function session() {
  const csrf = issueLoginCsrf();
  return login(password, new Request('http://localhost:3000/api/auth/login', { method: 'POST', headers: {
    origin: 'http://localhost:3000', cookie: csrf.cookie.split(';')[0], 'x-csrf-token': csrf.csrfToken, 'x-vercel-forwarded-for': '192.0.2.99',
  } }));
}
beforeAll(async () => {
  await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL', ''); vi.stubEnv('VERCEL_ENV', '');
  vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); vi.stubEnv('APP_ORIGIN', 'http://localhost:3000');
  vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('base64')); vi.stubEnv('INITIAL_PASSWORD_HASH', await hashPassword(password));
  await ensureSchema();
});
beforeEach(async () => {
  await query('TRUNCATE app_sessions, app_owner, auth_rate_limits, audit_events RESTART IDENTITY'); vi.clearAllMocks();
  vi.stubEnv('DISCOVERY_SCHEDULER_TOKEN', token); vi.stubEnv('EXECUTION_SCHEDULER_TOKEN', financialToken);
  service.discoveryReport.mockResolvedValue({ mode: 'paper-only', pairs: [] }); service.runDiscovery.mockResolvedValue({ status: 'completed' });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network in isolated API test'); }));
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });

describe('discovery API authentication boundary', () => {
  it('requires its independent scheduler credential and never accepts the financial scheduler credential', async () => {
    for (const bearer of [undefined, 'wrong', financialToken]) expect((await POST(request('tick', {}, bearer), context('tick'))).status).toBe(401);
    expect(service.runDiscovery).not.toHaveBeenCalled();
    expect((await POST(request('tick', {}, token), context('tick'))).status).toBe(200);
    expect(service.runDiscovery).toHaveBeenCalledExactlyOnceWith('scheduler'); expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['', 'short'])('rejects an unconfigured or weak scheduler secret even if supplied exactly', async secret => {
    vi.stubEnv('DISCOVERY_SCHEDULER_TOKEN', secret);
    expect((await POST(request('tick', {}, secret || financialToken), context('tick'))).status).toBe(401);
    expect(service.runDiscovery).not.toHaveBeenCalled();
  });

  it('does not let a scheduler bearer bypass session, CSRF, or Origin checks on the manual scan', async () => {
    expect((await POST(request('scan', {}, token, { origin: 'http://localhost:3000' }), context('scan'))).status).toBe(401);
    const own = await session(), cookie = `${sessionCookieName()}=${own.sessionToken}`;
    expect((await POST(request('scan', {}, token, { cookie, origin: 'http://localhost:3000' }), context('scan'))).status).toBe(403);
    expect((await POST(request('scan', {}, token, { cookie, origin: 'https://foreign.example', 'x-csrf-token': own.csrfToken }), context('scan'))).status).toBe(403);
    expect(service.runDiscovery).not.toHaveBeenCalled();
    const response = await POST(request('scan', {}, undefined, { cookie, origin: 'http://localhost:3000', 'x-csrf-token': own.csrfToken }), context('scan'));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ mode: 'paper-only', csrfToken: own.csrfToken });
    expect(service.runDiscovery).toHaveBeenCalledExactlyOnceWith('manual');
  });

  it('requires a browser session for reports and renews that session without caching', async () => {
    expect((await GET(new Request('http://localhost:3000/api/discovery/report', { headers: { Authorization: `Bearer ${token}` } }), context('report'))).status).toBe(401);
    expect(service.discoveryReport).not.toHaveBeenCalled();
    const own = await session();
    const response = await GET(new Request('http://localhost:3000/api/discovery/report', { headers: { cookie: `${sessionCookieName()}=${own.sessionToken}` } }), context('report'));
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('set-cookie')).toContain(sessionCookieName());
    expect(await response.json()).toMatchObject({ mode: 'paper-only', csrfToken: own.csrfToken });
  });

  it.each([{ symbol: 'NEW-EUR' }, { enableTrading: true }, { risk: 1 }])('rejects payloads that could inject pair selection or account settings', async payload => {
    expect((await POST(request('tick', payload, token), context('tick'))).status).toBe(400);
    expect(service.runDiscovery).not.toHaveBeenCalled();
  });

  it.each(['protect', 'deadline', 'settings', 'run'])('does not expose the financial action %s', async action => {
    expect((await POST(request(action, {}, token), context(action))).status).toBe(404);
    expect(service.runDiscovery).not.toHaveBeenCalled();
  });

  it.each(['busy', 'throttled'])('returns a bounded retry hint for %s', async status => {
    service.runDiscovery.mockResolvedValue({ status });
    const response = await POST(request('tick', {}, token), context('tick'));
    expect(response.status).toBe(409); expect(response.headers.get('retry-after')).toBe('60');
  });

  it('reports partial source work as unavailable and never exposes a raw service error', async () => {
    service.runDiscovery.mockResolvedValueOnce({ status: 'partial' });
    expect((await POST(request('tick', {}, token), context('tick'))).status).toBe(503);
    service.runDiscovery.mockRejectedValueOnce(new Error(`private database URL with ${token}`));
    const response = await POST(request('tick', {}, token), context('tick'));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain(token);
  });
});

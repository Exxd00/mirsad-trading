import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, ensureSchema, query } from '../src/lib/db';
import { hashPassword, issueLoginCsrf, login, sessionCookieName } from '../src/lib/auth';
import { POST as feasibility } from '../src/app/api/wallet/strategy/feasibility/route';
import { POST as setup } from '../src/app/api/wallet/strategy/setup/route';

// These are route boundaries only. No provider, wallet request, runtime,
// execution source or funds are created by the synthetic backend replies.
const ports = vi.hoisted(() => ({ audit: vi.fn(), setup: vi.fn() }));
vi.mock('../src/lib/wallet/cow-feasibility', () => ({ auditCowFeasibility: ports.audit }));
vi.mock('../src/lib/wallet/cow-setup', () => ({ prepareCowSetup: ports.setup }));
const origin = 'http://localhost:3000', owner = '0x1111111111111111111111111111111111111111';
const password = 'isolated-network-api-test-A8!';
type Session = Awaited<ReturnType<typeof login>>;
async function session() {
  const csrf = issueLoginCsrf();
  return login(password, new Request(origin + '/api/auth/login', { method: 'POST', headers: {
    origin, cookie: csrf.cookie.split(';')[0], 'x-csrf-token': csrf.csrfToken } }));
}
function request(own: Session | null, payload: unknown, headers: Record<string, string> = {}) {
  return new Request(origin + '/api/wallet/strategy/setup', { method: 'POST', headers: { origin, 'content-type': 'application/json',
    ...(own ? { cookie: `${sessionCookieName()}=${own.sessionToken}`, 'x-csrf-token': own.csrfToken } : {}), ...headers }, body: JSON.stringify(payload) });
}
beforeAll(async () => {
  await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL', ''); vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); vi.stubEnv('APP_ORIGIN', origin); vi.stubEnv('MIRSAD_RETIRE_LEGACY_CONNECTION', undefined);
  vi.stubEnv('INITIAL_PASSWORD_HASH', await hashPassword(password)); await ensureSchema();
});
beforeEach(async () => {
  await query('TRUNCATE app_settings,app_owner,app_sessions,auth_rate_limits,audit_events RESTART IDENTITY');
  ports.audit.mockReset(); ports.setup.mockReset();
  ports.audit.mockResolvedValue({ decision: 'blocked', createdExecutionState: false }); ports.setup.mockResolvedValue({ status: 'funding-required' });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('no external calls in isolated API tests'); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });

describe.each([
  { label: 'feasibility', route: feasibility, port: ports.audit, action: {} },
  { label: 'setup', route: setup, port: ports.setup, action: { action: 'prepare' } },
])('explicit wallet network $label route', ({ route, port, action }) => {
  it('requires owner authentication, CSRF and same origin before evaluating a chain100 request', async () => {
    const value = { ...action, owner, chainId: 100 };
    expect((await route(request(null, value))).status).toBe(401);
    const own = await session();
    expect((await route(request(own, value, { 'x-csrf-token': 'wrong' }))).status).toBe(403);
    expect((await route(request(own, value, { origin: 'https://attacker.invalid' }))).status).toBe(403);
    expect(port).not.toHaveBeenCalled(); expect((await query('SELECT key FROM app_settings')).rowCount).toBe(0);
  });
  it.each([1, 100])('passes the explicit network %s unchanged to its backend without financial state changes', async chainId => {
    const own = await session(), before = (await query('SELECT key,value,updated_at FROM app_settings')).rows;
    const response = await route(request(own, { ...action, owner, chainId }));
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('private, no-store');
    expect(port).toHaveBeenCalledExactlyOnceWith(owner, chainId);
    expect((await query('SELECT key,value,updated_at FROM app_settings')).rows).toEqual(before);
  });
  it('rejects omitted, textual, unknown, trial or extra network authority instead of choosing a default', async () => {
    const own = await session();
    for (const chainId of [undefined, '100', '0x64', 84532, 8453, 137, null]) {
      const response = await route(request(own, { ...action, owner, chainId }));
      expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: 'wallet_authority_request_invalid' });
    }
    expect((await route(request(own, { ...action, owner, chainId: 100, rpcUrl: 'https://attacker.invalid' }))).status).toBe(409);
    expect(port).not.toHaveBeenCalled(); expect((await query('SELECT key FROM app_settings')).rowCount).toBe(0);
  });
});

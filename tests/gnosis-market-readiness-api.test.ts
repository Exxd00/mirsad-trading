import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, ensureSchema, query } from '../src/lib/db';
import { hashPassword, issueLoginCsrf, login, sessionCookieName } from '../src/lib/auth';
import { GET, POST } from '../src/app/api/wallet/strategy/market-readiness/route';
const source = vi.hoisted(() => ({ start: vi.fn(), read: vi.fn(), resumeExisting: vi.fn() }));
vi.mock('../src/lib/wallet/gnosis-market-readiness-job', async original => ({ ...await original<typeof import('../src/lib/wallet/gnosis-market-readiness-job')>(),
  startGnosisMarketReadiness: source.start, readGnosisMarketReadiness: source.read, resumeExistingGnosisMarketReadiness: source.resumeExisting }));
import { GnosisMarketReadinessJobConflict } from '../src/lib/wallet/gnosis-market-readiness-job';
const origin = 'http://localhost:3000', password = 'isolated-market-source-test-A8!';
type Session = Awaited<ReturnType<typeof login>>;
async function session() {
  const csrf = issueLoginCsrf(); return login(password, new Request(origin + '/api/auth/login', { method: 'POST', headers: {
    origin, cookie: csrf.cookie.split(';')[0], 'x-csrf-token': csrf.csrfToken } }));
}
function request(own: Session | null, input: unknown = { chainId: 100 }, extra: Record<string, string> = {}) {
  return new Request(origin + '/api/wallet/strategy/market-readiness', { method: 'POST', headers: { origin, 'content-type': 'application/json',
    ...(own ? { cookie: `${sessionCookieName()}=${own.sessionToken}`, 'x-csrf-token': own.csrfToken } : {}), ...extra }, body: JSON.stringify(input) });
}
beforeAll(async () => {
  await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL', ''); vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); vi.stubEnv('APP_ORIGIN', origin); vi.stubEnv('MIRSAD_RETIRE_LEGACY_CONNECTION', undefined);
  vi.stubEnv('INITIAL_PASSWORD_HASH', await hashPassword(password)); await ensureSchema();
});
beforeEach(async () => {
  await query('TRUNCATE app_settings,app_owner,app_sessions,auth_rate_limits,audit_events RESTART IDENTITY'); source.start.mockReset(); source.read.mockReset(); source.resumeExisting.mockReset();
  source.read.mockResolvedValue({ job: null, report: null });
  source.start.mockResolvedValue({ job: { state: 'waiting', attempts: 1, nextAt: 1794790300, expiresAt: 1794811600, lastTrigger: 'manual', lastError: null },
    report: { version: 1, chainId: 100, status: 'warming', referenceOnly: true, financialReadiness: 'not-certified',
      createdExecutionState: false, readAt: 1794790000, retryAt: 1794790300, errors: [], history: { completedCandles: 200, complete: false } } });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('no external network in owner API tests'); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });
describe('owner-only public-data source preflight', () => {
  it('resumes only a strict expected existing identity under owner CSRF and never falls back to start', async () => {
    const id = '00000000-0000-4000-8000-000000000001', value = { chainId: 100, action: 'resume-existing', expectedJobId: id };
    expect((await POST(request(null, value))).status).toBe(401); const own = await session();
    expect((await POST(request(own, value, { 'x-csrf-token': 'invalid' }))).status).toBe(403);
    for (const input of [{ ...value, expectedJobId: 'invalid' }, { ...value, force: true }, { ...value, chainId: 1 }, { chainId: 100, action: 'resume-existing' }])
      expect((await POST(request(own, input))).status).toBe(409);
    source.resumeExisting.mockResolvedValue({ job: { id, state: 'waiting' } });
    expect(await (await POST(request(own, value))).json()).toMatchObject({ job: { id, state: 'waiting' } });
    expect(source.resumeExisting).toHaveBeenCalledExactlyOnceWith(id); expect(source.start).not.toHaveBeenCalled();
    source.resumeExisting.mockRejectedValueOnce(new GnosisMarketReadinessJobConflict());
    const changed = await POST(request(own, value)); expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ code: 'wallet_market_readiness_job_changed' }); expect(source.start).not.toHaveBeenCalled();
  });
  it('requires a real owner session, CSRF and same origin before warming any public evidence', async () => {
    expect((await POST(request(null))).status).toBe(401);
    expect((await POST(request(null, { chainId: 100 }, { authorization: 'Bearer scheduler-is-not-owner' }))).status).toBe(401);
    const own = await session();
    for (const extra of [{ 'x-csrf-token': 'invalid' }, { origin: 'https://attacker.invalid' }, { 'sec-fetch-site': 'cross-site' }] as Record<string, string>[])
      expect((await POST(request(own, { chainId: 100 }, extra))).status).toBe(403);
    expect(source.start).not.toHaveBeenCalled(); expect((await query('SELECT key FROM app_settings')).rowCount).toBe(0);
  });
  it('accepts only explicit chain100, with no owner funds, arbitrary URL, profile or activation input', async () => {
    const own = await session();
    for (const input of [{}, { chainId: 1 }, { chainId: '100' }, { chainId: 84532 }, { chainId: 100, owner: '0x' + '1'.repeat(40) },
      { chainId: 100, rpcUrl: 'https://attacker.invalid' }, { chainId: 100, executionArmed: true }]) {
      const response = await POST(request(own, input)); expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'wallet_authority_request_invalid' });
    }
    expect(source.start).not.toHaveBeenCalled();
    const before = (await query('SELECT key,value,updated_at FROM app_settings')).rows;
    const response = await POST(request(own)); expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('private, no-store'); expect(response.headers.get('set-cookie')).toBeTruthy();
    expect(await response.json()).toMatchObject({ report: { referenceOnly: true, createdExecutionState: false, financialReadiness: 'not-certified' }, csrfToken: own.csrfToken });
    expect(source.start).toHaveBeenCalledExactlyOnceWith(); expect((await query('SELECT key,value,updated_at FROM app_settings')).rows).toEqual(before);
  });
  it('sanitizes unknown provider or database errors without creating a financial fallback', async () => {
    source.start.mockRejectedValue(new Error('https://private:secret@provider.invalid'));
    const response = await POST(request(await session())); expect(response.status).toBe(503);
    const value = await response.json(); expect(value.code).toBe('SERVICE_UNAVAILABLE'); expect(JSON.stringify(value)).not.toMatch(/private|secret|provider\.invalid/);
    expect((await query('SELECT key FROM app_settings')).rowCount).toBe(0);
  });
  it('serves protected stored progress on GET without starting or resuming a market read', async () => {
    expect((await GET(new Request(origin + '/api/wallet/strategy/market-readiness'))).status).toBe(401);
    expect(source.read).not.toHaveBeenCalled();
    const own = await session(), response = await GET(new Request(origin + '/api/wallet/strategy/market-readiness', { headers: { cookie: `${sessionCookieName()}=${own.sessionToken}` } }));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ job: null, report: null, csrfToken: own.csrfToken });
    expect(response.headers.get('cache-control')).toContain('private, no-store');
    expect(source.read).toHaveBeenCalledExactlyOnceWith(); expect(source.start).not.toHaveBeenCalled();
  });
});

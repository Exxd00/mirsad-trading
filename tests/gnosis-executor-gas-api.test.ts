import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, ensureSchema, query } from '../src/lib/db';
import { hashPassword, issueLoginCsrf, login, sessionCookieName } from '../src/lib/auth';
const services = vi.hoisted(() => ({ prepareExecutorGasReview: vi.fn() }));
const attempts = vi.hoisted(() => ({ cancelExecutorGasUnsent: vi.fn(), markExecutorGasUnknown: vi.fn(), readExecutorGasFence: vi.fn(),
  recordExecutorGasHash: vi.fn(), rejectExecutorGas: vi.fn(), reserveExecutorGas: vi.fn(), resolveExecutorGasAttempt: vi.fn(), saveExecutorGasArtifact: vi.fn() }));
vi.mock('../src/lib/wallet/gnosis-executor-gas', async original => ({ ...await original<typeof import('../src/lib/wallet/gnosis-executor-gas')>(), ...services }));
vi.mock('../src/lib/wallet/gnosis-executor-gas-attempts', () => attempts);
import { GET, POST } from '../src/app/api/wallet/strategy/executor-gas/route';
const origin = 'http://localhost:3000', owner = '0x1111111111111111111111111111111111111111', expectedExecutor = '0x2222222222222222222222222222222222222222';
const password = 'isolated-executor-gas-owner-B7!', digest = '0x' + '11'.repeat(32), id = '00000000-0000-4000-8000-000000000001';
type Session = Awaited<ReturnType<typeof login>>;
async function session() { const c = issueLoginCsrf(); return login(password, new Request(origin + '/api/auth/login', { method: 'POST', headers: {
  origin, cookie: c.cookie.split(';')[0], 'x-csrf-token': c.csrfToken } })); }
function request(s: Session | null, input: unknown = { action: 'review', owner, chainId: 100, expectedExecutor }, extra: Record<string, string> = {}) {
  return new Request(origin + '/api/wallet/strategy/executor-gas', { method: 'POST', headers: { origin, 'content-type': 'application/json',
    ...(s ? { cookie: `${sessionCookieName()}=${s.sessionToken}`, 'x-csrf-token': s.csrfToken } : {}), ...extra }, body: JSON.stringify(input) });
}
beforeAll(async () => { await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL', ''); vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); vi.stubEnv('APP_ORIGIN', origin); vi.stubEnv('INITIAL_PASSWORD_HASH', await hashPassword(password));
  vi.stubEnv('MIRSAD_RETIRE_LEGACY_CONNECTION', undefined); await ensureSchema(); });
beforeEach(async () => {
  await query('TRUNCATE app_settings,app_owner,app_sessions,auth_rate_limits,audit_events RESTART IDENTITY');
  for (const fn of [...Object.values(services), ...Object.values(attempts)]) fn.mockReset();
  attempts.readExecutorGasFence.mockResolvedValue({ blocked: false, active: null, last: null });
  services.prepareExecutorGasReview.mockResolvedValue({ audit: { owner, executor: expectedExecutor, status: 'reviewable', ownerReviewAllowed: false, executionApproved: false, blockers: [] },
    context: { signerFingerprint: 'private-context-must-not-be-returned' } });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No external/financial calls in private API tests'); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });
describe('owner-only bounded native executor funding API', () => {
  it('requires an actual owner session, CSRF and same origin before expensive reads or reservation', async () => {
    expect((await POST(request(null))).status).toBe(401);
    expect((await POST(request(null, undefined, { authorization: 'Bearer scheduler-not-owner' }))).status).toBe(401);
    const s = await session();
    for (const headers of [{ 'x-csrf-token': 'invalid' }, { origin: 'https://attacker.invalid' }, { 'sec-fetch-site': 'cross-site' }] as Record<string, string>[])
      expect((await POST(request(s, undefined, headers))).status).toBe(403);
    expect(services.prepareExecutorGasReview).not.toHaveBeenCalled(); expect(attempts.reserveExecutorGas).not.toHaveBeenCalled();
  });
  it('accepts only the explicit configured Gnosis executor and fixed actions, never caller amount/calldata/fee/source activation', async () => {
    const s = await session(), valid = { action: 'review', owner, chainId: 100, expectedExecutor };
    for (const input of [{ ...valid, chainId: 1 }, { ...valid, chainId: '100' }, { ...valid, value: '0x1' }, { ...valid, data: '0x1234' },
      { ...valid, gas: '0x5208' }, { ...valid, executionArmed: true }, { action: 'send', owner, chainId: 100 },
      { action: 'cancel-unsent', owner, chainId: 100, attemptId: id, snapshotDigest: digest, requestIssued: true }])
      expect((await POST(request(s, input))).status).toBe(409);
    expect(services.prepareExecutorGasReview).not.toHaveBeenCalled();
    const response = await POST(request(s, valid)); expect(response.status).toBe(200);
    expect(services.prepareExecutorGasReview).toHaveBeenCalledExactlyOnceWith(owner, expectedExecutor);
    expect(await response.json()).toMatchObject({ ownerReviewAllowed: true, executionApproved: false });
    expect(response.headers.get('cache-control')).toContain('private, no-store'); expect(response.headers.get('set-cookie')).toBeTruthy();
  });
  it('lets an existing durable fence override a freshly reviewable gas snapshot and does not expose private context', async () => {
    attempts.readExecutorGasFence.mockResolvedValue({ blocked: true, active: { id }, last: null });
    const data = await (await POST(request(await session()))).json();
    expect(data.ownerReviewAllowed).toBe(false); expect(data.blockers).toContain('wallet_executor_gas_attempt_pending');
    expect(JSON.stringify(data)).not.toContain('private-context');
    expect(attempts.saveExecutorGasArtifact).toHaveBeenCalledOnce();
  });
  it('dispatches exact reserve/hash/unknown/rejection/unsent/resolve requests, preserving their separate semantics', async () => {
    const s = await session(), shared = { owner, chainId: 100 };
    for (const input of [{ ...shared, action: 'reserve', expectedExecutor, reviewDigest: digest, proofDigest: digest },
      { ...shared, action: 'record', attemptId: id, transactionHash: digest }, { ...shared, action: 'unknown', attemptId: id },
      { ...shared, action: 'reject', attemptId: id, code: 4001 }, { ...shared, action: 'cancel-unsent', attemptId: id, snapshotDigest: digest, requestIssued: false },
      { ...shared, action: 'resolve', attemptId: id }]) expect((await POST(request(s, input))).status).toBe(200);
    expect(attempts.reserveExecutorGas).toHaveBeenCalledExactlyOnceWith({ action: 'reserve', owner, chainId: 100, expectedExecutor, reviewDigest: digest, proofDigest: digest });
    expect(attempts.recordExecutorGasHash).toHaveBeenCalledExactlyOnceWith(owner, id, digest);
    expect(attempts.cancelExecutorGasUnsent).toHaveBeenCalledExactlyOnceWith(owner, id, digest, false);
    expect(attempts.resolveExecutorGasAttempt).toHaveBeenCalledExactlyOnceWith(owner, id);
  });
  it('serves protected stored progress without creating a key, artifact or network request', async () => {
    expect((await GET(new Request(origin + '/api/wallet/strategy/executor-gas?owner=' + owner))).status).toBe(401);
    const s = await session(), request = new Request(origin + '/api/wallet/strategy/executor-gas?owner=' + owner, { headers: { cookie: `${sessionCookieName()}=${s.sessionToken}` } });
    const response = await GET(request); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ fence: { blocked: false, active: null } });
    expect(services.prepareExecutorGasReview).not.toHaveBeenCalled(); expect(attempts.saveExecutorGasArtifact).not.toHaveBeenCalled();
  });
  it('sanitizes raw provider/SQL failures without changing a pending attempt or returning credentials', async () => {
    services.prepareExecutorGasReview.mockRejectedValueOnce(new Error('https://private:secret@rpc.invalid'));
    const response = await POST(request(await session())); expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toMatch(/private|secret|rpc.invalid/);
    expect(attempts.saveExecutorGasArtifact).not.toHaveBeenCalled();
  });
});

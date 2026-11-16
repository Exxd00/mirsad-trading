import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, ensureSchema, query } from '../src/lib/db';
import { hashPassword, issueLoginCsrf, login, sessionCookieName } from '../src/lib/auth';
import { GET, POST } from '../src/app/api/wallet/strategy/authority/route';
import { AuthorityError } from '../src/lib/wallet/authority';
const attempt = vi.hoisted(() => ({ readAuthorityActionFence: vi.fn(), reserveAuthorityAction: vi.fn(), recordAuthorityActionReferences: vi.fn(),
  markAuthorityActionUnknown: vi.fn(), rejectAuthorityAction: vi.fn(), cancelAuthorityActionUnsent: vi.fn(), resolveAuthorityAction: vi.fn() }));
vi.mock('../src/lib/wallet/authority-action-attempts', () => attempt);
const environment = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../src/lib/wallet/authority-environment', () => ({ productionAuthorityEnvironment: environment.load }));
const origin = 'http://localhost:3000', url = origin + '/api/wallet/strategy/authority', password = 'isolated-action-api-password-A8!';
const id = '00000000-0000-4000-8000-000000000001', digest = ('0x' + 'a'.repeat(64)) as `0x${string}`;
type Session = Awaited<ReturnType<typeof login>>;
async function ownerSession() { const c = issueLoginCsrf(); return login(password, new Request(origin + '/api/auth/login', { method: 'POST',
  headers: { origin, cookie: c.cookie.split(';')[0], 'x-csrf-token': c.csrfToken } })); }
function request(s: Session | null, value: unknown, extra: Record<string, string> = {}) { return new Request(url, { method: 'POST',
  headers: { origin, 'content-type': 'application/json', ...(s ? { cookie: `${sessionCookieName()}=${s.sessionToken}`, 'x-csrf-token': s.csrfToken } : {}), ...extra }, body: JSON.stringify(value) }); }
const identity = { attemptId: id, snapshotDigest: digest }, reserve = { action: 'reserve-action', id, digest, expectedRevision: 1, phase: 'bootstrap' };
beforeAll(async () => { await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('VERCEL', ''); vi.stubEnv('VERCEL_ENV', '');
  vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); vi.stubEnv('APP_ORIGIN', origin); vi.stubEnv('ENCRYPTION_KEY', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  vi.stubEnv('INITIAL_PASSWORD_HASH', await hashPassword(password)); await ensureSchema(); });
beforeEach(async () => { await query('TRUNCATE app_settings,app_owner,app_sessions,auth_rate_limits,audit_events RESTART IDENTITY');
  for (const f of Object.values(attempt)) f.mockReset(); environment.load.mockReset(); environment.load.mockResolvedValue({});
  attempt.readAuthorityActionFence.mockResolvedValue({ blocked: false, active: null, last: null });
  for (const f of Object.values(attempt).filter(f => f !== attempt.readAuthorityActionFence && f !== attempt.reserveAuthorityAction)) f.mockResolvedValue({ attempt: { id } });
  attempt.reserveAuthorityAction.mockResolvedValue({ version: 1, attempt: { id } });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No wallet/network operations in private route tests'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });
describe('private authority pre-prompt metadata API', () => {
  it('requires owner session, CSRF and origin for every action before reservation or metadata work', async () => {
    for (const action of ['reserve-action', 'record-action', 'unknown-action', 'reject-action', 'cancel-unsent-action', 'resolve-action'])
      expect((await POST(request(null, { ...identity, action }, { authorization: 'Bearer scheduler-not-owner' }))).status).toBe(401);
    const s = await ownerSession();
    for (const extra of [{ origin: 'https://attacker.invalid' }, { 'x-csrf-token': 'invalid' }] as Record<string, string>[]) expect((await POST(request(s, reserve, extra))).status).toBe(403);
    expect(attempt.reserveAuthorityAction).not.toHaveBeenCalled(); expect(environment.load).not.toHaveBeenCalled();
  });
  it('rejects arbitrary payload, caller proof, non4001 and false-unsent overrides', async () => {
    const s = await ownerSession();
    for (const v of [{ ...reserve, payload: {} }, { ...reserve, phase: 'send' }, { action: 'record-action', ...identity, verified: true },
      { action: 'reject-action', ...identity, code: -32000 }, { action: 'cancel-unsent-action', ...identity, requestIssued: true },
      { action: 'record-action', ...identity, callBatchIds: ['0x1', '0x2'] }]) expect((await POST(request(s, v))).status).toBe(409);
    expect(attempt.reserveAuthorityAction).not.toHaveBeenCalled(); expect(environment.load).not.toHaveBeenCalled();
  });
  it('requires a production environment before reservation but records late references without one or a current revision', async () => {
    const s = await ownerSession(); environment.load.mockResolvedValue(null);
    expect((await POST(request(s, reserve))).status).toBe(409); expect(attempt.reserveAuthorityAction).not.toHaveBeenCalled();
    environment.load.mockClear();
    const response = await POST(request(s, { action: 'record-action', ...identity, transactionHashes: [digest] }));
    expect(response.status).toBe(200); expect(environment.load).not.toHaveBeenCalled();
    expect(attempt.recordAuthorityActionReferences).toHaveBeenCalledWith(expect.objectContaining({ ...identity, transactionHashes: [digest] }));
    expect(await response.json()).toMatchObject({ actionAttempt: { id }, actionFence: { blocked: false } });
  });
  it('returns the reservation and exact independent recovery result, never a server send', async () => {
    const s = await ownerSession(); expect((await (await POST(request(s, reserve))).json()).actionReservation).toEqual({ version: 1, attempt: { id } });
    for (const v of [{ action: 'unknown-action', ...identity }, { action: 'reject-action', ...identity, code: 4001 },
      { action: 'cancel-unsent-action', ...identity, requestIssued: false }, { action: 'resolve-action', ...identity, transactionHashes: [digest] }])
      expect((await POST(request(s, v))).status).toBe(200);
    expect(attempt.cancelAuthorityActionUnsent).toHaveBeenCalledWith(id, digest, false);
    expect(attempt.resolveAuthorityAction).toHaveBeenCalledWith(id, digest, [digest]);
  });
  it('serves only stored fence metadata on authenticated GET with private/no-store headers', async () => {
    expect((await GET(new Request(url))).status).toBe(401); const s = await ownerSession(), before = (await query('SELECT key,value FROM app_settings')).rows;
    attempt.readAuthorityActionFence.mockResolvedValue({ blocked: true, active: { id }, last: null });
    const response = await GET(new Request(url, { headers: { cookie: `${sessionCookieName()}=${s.sessionToken}` } }));
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('private, no-store');
    expect(await response.json()).toMatchObject({ actionFence: { blocked: true, active: { id } } });
    expect((await query('SELECT key,value FROM app_settings')).rows).toEqual(before);
  });
  it('sanitizes internal failures and exposes only allowlisted action errors', async () => {
    const s = await ownerSession(); attempt.markAuthorityActionUnknown.mockRejectedValueOnce(new Error('private-provider-key-value'));
    const r = await POST(request(s, { action: 'unknown-action', ...identity })); expect(JSON.stringify(await r.json())).not.toContain('private-provider-key-value');
    attempt.markAuthorityActionUnknown.mockRejectedValueOnce(new AuthorityError('wallet_authority_action_pending'));
    expect(await (await POST(request(s, { action: 'unknown-action', ...identity }))).json()).toMatchObject({ code: 'wallet_authority_action_pending' });
  });
});

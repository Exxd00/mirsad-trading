import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, ensureSchema, query } from '../src/lib/db';
import { hashPassword, issueLoginCsrf, login, sessionCookieName } from '../src/lib/auth';
import { GnosisFundingError } from '../src/lib/wallet/gnosis-funding-service';
import { GET, POST } from '../src/app/api/wallet/strategy/funding/route';
const ports = vi.hoisted(() => ({ prepare: vi.fn(), save: vi.fn(), fence: vi.fn(), reserve: vi.fn(), record: vi.fn(), resolve: vi.fn(), unknown: vi.fn(), reject: vi.fn(), cancelUnsent: vi.fn() }));
vi.mock('../src/lib/wallet/gnosis-funding-service', async original => ({ ...await original<typeof import('../src/lib/wallet/gnosis-funding-service')>(), prepareGnosisFundingReview: ports.prepare }));
vi.mock('../src/lib/wallet/gnosis-funding-attempts', () => ({ saveGnosisFundingArtifact: ports.save, readGnosisFundingFence: ports.fence,
  reserveGnosisFundingAttempt: ports.reserve, recordGnosisFundingHash: ports.record, resolveGnosisFundingAttempt: ports.resolve,
  markGnosisFundingUnknown: ports.unknown, attestGnosisFundingRejection: ports.reject, cancelGnosisFundingUnsent: ports.cancelUnsent }));
const origin = 'http://localhost:3000', endpoint = origin + '/api/wallet/strategy/funding';
const owner = '0x1111111111111111111111111111111111111111', digest = ('0x' + 'a'.repeat(64)) as `0x${string}`;
const id = '00000000-0000-4000-8000-000000000001', password = 'isolated-funding-api-test-A8!';
type Session = Awaited<ReturnType<typeof login>>;
async function session() {
  const csrf = issueLoginCsrf(); return login(password, new Request(origin + '/api/auth/login', { method: 'POST', headers: {
    origin, cookie: csrf.cookie.split(';')[0], 'x-csrf-token': csrf.csrfToken } }));
}
function request(own: Session | null, input: unknown, extra: Record<string, string> = {}) {
  return new Request(endpoint, { method: 'POST', headers: { origin, 'content-type': 'application/json',
    ...(own ? { cookie: `${sessionCookieName()}=${own.sessionToken}`, 'x-csrf-token': own.csrfToken } : {}), ...extra }, body: JSON.stringify(input) });
}
const get = (own: Session | null, suffix = '?owner=' + owner) => GET(new Request(endpoint + suffix,
  { headers: own ? { cookie: `${sessionCookieName()}=${own.sessionToken}` } : {} }));
const quote = { action: 'quote', owner, chainId: 1 };
beforeAll(async () => {
  await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL', ''); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://');
  vi.stubEnv('APP_ORIGIN', origin); vi.stubEnv('MIRSAD_RETIRE_LEGACY_CONNECTION', undefined); vi.stubEnv('INITIAL_PASSWORD_HASH', await hashPassword(password)); await ensureSchema();
});
beforeEach(async () => {
  await query('TRUNCATE app_settings,app_owner,app_sessions,auth_rate_limits,audit_events RESTART IDENTITY');
  Object.values(ports).forEach(p => p.mockReset());
  ports.prepare.mockResolvedValue({ audit: { version: 1, status: 'blocked', referenceOnly: true, ownerReviewAllowed: false,
    blockers: ['wallet_gnosis_funding_history_unavailable'], unverified: ['prior-owner-prompt-attempt-state', 'destination-arrival'] },
    rawQuote: { mustNeverReachPublicDto: 'private-artifact-sentinel' } });
  ports.fence.mockResolvedValue({ blocked: false, active: null, fundCompleted: false });
  for (const p of [ports.reserve, ports.record, ports.resolve, ports.unknown, ports.reject, ports.cancelUnsent]) p.mockResolvedValue({ status: 'read-only-test-result' });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('no financial/provider calls from isolated API tests'); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });
describe('authenticated, strict owner funding-review API boundary', () => {
  it('requires a real owner session for GET and CSRF plus same origin for every POST before calling services', async () => {
    expect((await get(null)).status).toBe(401); expect((await POST(request(null, quote))).status).toBe(401);
    expect((await POST(request(null, quote, { authorization: 'Bearer scheduler-is-not-owner' }))).status).toBe(401);
    const own = await session();
    for (const extra of [{ 'x-csrf-token': 'invalid' }, { origin: 'https://attacker.invalid' }, { 'sec-fetch-site': 'cross-site' }] as Record<string, string>[])
      expect((await POST(request(own, quote, extra))).status).toBe(403);
    Object.values(ports).forEach(p => expect(p).not.toHaveBeenCalled());
  });
  it('serves stored pending-attempt references on GET without preparing quotes or allowing ambiguous owner queries', async () => {
    const own = await session();
    for (const suffix of ['', '?owner=' + owner + '&owner=' + owner, '?owner=' + owner + '&chainId=1', '?owner=0x' + '0'.repeat(40)])
      expect((await get(own, suffix)).status).toBe(409);
    expect(ports.fence).not.toHaveBeenCalled(); const response = await get(own);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ fence: { blocked: false }, csrfToken: own.csrfToken });
    expect(ports.fence).toHaveBeenCalledExactlyOnceWith(owner); expect(ports.prepare).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toContain('private, no-store');
  });
  it('rejects alternate chains, arbitrary transactions/proofs, missing identity and activation flags', async () => {
    const own = await session();
    for (const input of [{ ...quote, chainId: 100 }, { ...quote, chainId: '1' }, { ...quote, data: '0xdead' }, { ...quote, verified: true },
      { ...quote, action: 'send' }, { owner, chainId: 1, action: 'reserve', phase: 'fund' },
      { owner, chainId: 1, action: 'record', attemptId: 'wrong', transactionHash: digest },
      { owner, chainId: 1, action: 'reject', attemptId: id, code: -32000 }, { ...quote, executionArmed: true },
      { owner, chainId: 1, action: 'cancel-unsent', attemptId: id, snapshotDigest: digest },
      { owner, chainId: 1, action: 'cancel-unsent', attemptId: id, snapshotDigest: digest, requestIssued: true },
      { owner, chainId: 1, action: 'cancel-unsent', attemptId: id, snapshotDigest: digest, requestIssued: false, mempoolAbsent: true }]) {
      const response = await POST(request(own, input)); expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'wallet_gnosis_funding_request_invalid' });
    }
    Object.values(ports).forEach(p => expect(p).not.toHaveBeenCalled());
  });
  it('returns only the reviewed audit, preserves financial state and overrides review permission while a prior attempt is pending', async () => {
    const own = await session(), before = (await query('SELECT key,value,updated_at FROM app_settings')).rows;
    const response = await POST(request(own, quote)); expect(response.status).toBe(200);
    const result = await response.json(); expect(result).toMatchObject({ status: 'blocked', ownerReviewAllowed: false, unverified: ['destination-arrival'] });
    expect(JSON.stringify(result)).not.toMatch(/rawQuote|private-artifact-sentinel/);
    expect(ports.prepare).toHaveBeenCalledExactlyOnceWith(owner); expect(ports.save).toHaveBeenCalledOnce();
    expect((await query('SELECT key,value,updated_at FROM app_settings')).rows).toEqual(before);
    ports.prepare.mockResolvedValue({ audit: { status: 'reviewable', ownerReviewAllowed: true, blockers: [], unverified: [] }, rawQuote: null });
    ports.fence.mockResolvedValue({ blocked: true, active: { id, status: 'unknown' }, fundCompleted: false });
    const pending = await POST(request(own, quote)); expect(await pending.json()).toMatchObject({ ownerReviewAllowed: false, blockers: ['wallet_gnosis_funding_attempt_pending'] });
  });
  it('dispatches only the bounded attempt-state actions, never a raw transaction or wallet request', async () => {
    const own = await session();
    const reservation = { owner, chainId: 1, action: 'reserve', phase: 'approve', reviewDigest: digest, proofDigest: digest };
    expect((await POST(request(own, reservation))).status).toBe(200); expect(ports.reserve).toHaveBeenCalledExactlyOnceWith(reservation);
    for (const [action, port] of [['record', ports.record], ['resolve', ports.resolve], ['unknown', ports.unknown], ['reject', ports.reject]] as const) {
      const response = await POST(request(own, { owner, chainId: 1, action, attemptId: id,
        ...(action === 'record' ? { transactionHash: digest } : action === 'reject' ? { code: 4001 } : {}) }));
      expect(response.status).toBe(200);
      expect(port).toHaveBeenCalledExactlyOnceWith(owner, id, ...(action === 'record' ? [digest] : action === 'reject' ? [4001] : []));
    }
    const cancelled = await POST(request(own, { owner, chainId: 1, action: 'cancel-unsent', attemptId: id, snapshotDigest: digest, requestIssued: false }));
    expect(cancelled.status).toBe(200); expect(ports.cancelUnsent).toHaveBeenCalledExactlyOnceWith(owner, id, digest, false);
    expect(ports.prepare).not.toHaveBeenCalled(); expect(ports.save).not.toHaveBeenCalled();
  });
  it('sanitizes service, provider and database failures without logging a raw quote or credentials', async () => {
    const own = await session(); ports.prepare.mockRejectedValueOnce(new GnosisFundingError('wallet_gnosis_funding_request_invalid'));
    expect((await POST(request(own, quote))).status).toBe(409);
    ports.prepare.mockRejectedValueOnce(new Error('https://private:secret@provider.invalid'));
    const response = await POST(request(own, quote)); expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toMatch(/private|secret|provider\.invalid/); expect(ports.save).not.toHaveBeenCalled();
  });
});

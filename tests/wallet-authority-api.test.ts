import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, ensureSchema, query } from '../src/lib/db';
import { hashPassword, issueLoginCsrf, login, sessionCookieName } from '../src/lib/auth';
import { saveStrategyProfile } from '../src/lib/wallet/strategy-profile';
import { loadAuthority, loadVerifiedAuthorityForRuntime } from '../src/lib/wallet/authority-store';
import { AuthorityError } from '../src/lib/wallet/authority';
import { authorityEnvironment, authorityProfile, NOW, owner } from './fixtures/wallet-authority';
import { GET, POST } from '../src/app/api/wallet/strategy/authority/route';
import { POST as feasibilityPOST } from '../src/app/api/wallet/strategy/feasibility/route';

const adapter = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../src/lib/wallet/authority-environment', () => ({ productionAuthorityEnvironment: adapter.load }));
const feasibility = vi.hoisted(() => ({ guard: vi.fn(), audit: vi.fn() }));
vi.mock('../src/lib/wallet/cow-feasibility', () => ({ assertCowSetupFeasible: feasibility.guard, auditCowFeasibility: feasibility.audit }));
const origin = 'http://localhost:3000', endpoint = origin + '/api/wallet/strategy/authority';
const password = 'isolated-authority-api-password-A8!';
type Login = Awaited<ReturnType<typeof login>>;
async function session() {
  const csrf = issueLoginCsrf();
  return login(password, new Request(origin + '/api/auth/login', { method: 'POST', headers: {
    origin, cookie: csrf.cookie.split(';')[0], 'x-csrf-token': csrf.csrfToken,
  } }));
}
function request(own: Login | null, value: unknown, extra: Record<string, string> = {}) {
  return new Request(endpoint, { method: 'POST', headers: { origin, 'content-type': 'application/json',
    ...(own ? { cookie: `${sessionCookieName()}=${own.sessionToken}`, 'x-csrf-token': own.csrfToken } : {}), ...extra }, body: JSON.stringify(value) });
}
const get = (own: Login | null) => GET(new Request(endpoint, { headers: own ? { cookie: `${sessionCookieName()}=${own.sessionToken}` } : {} }));
beforeAll(async () => {
  await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL', ''); vi.stubEnv('VERCEL_ENV', '');
  vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); vi.stubEnv('APP_ORIGIN', origin);
  vi.stubEnv('ENCRYPTION_KEY', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  vi.stubEnv('INITIAL_PASSWORD_HASH', await hashPassword(password)); await ensureSchema();
});
beforeEach(async () => {
  await query('TRUNCATE app_settings, app_sessions, app_owner, auth_rate_limits, audit_events, order_intents RESTART IDENTITY');
  adapter.load.mockReset(); adapter.load.mockResolvedValue(authorityEnvironment());
  feasibility.guard.mockReset(); feasibility.guard.mockResolvedValue({ decision: 'eligible-for-setup' });
  feasibility.audit.mockReset(); feasibility.audit.mockResolvedValue({ decision: 'blocked', createdExecutionState: false });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network must not run in authority API tests'); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });
describe('owner-only authority route', () => {
  it('rejects anonymous read and mutation or scheduler bearer before evaluating the authority adapter', async () => {
    expect((await get(null)).status).toBe(401);
    const extras: Record<string, string>[] = [{}, { authorization: 'Bearer isolated-scheduler-token-never-owner' }];
    for (const extra of extras) {
      expect((await POST(request(null, { action: 'prepare', expectedRevision: null }, extra))).status).toBe(401);
    }
    expect(adapter.load).not.toHaveBeenCalled(); expect(await loadAuthority({ query })).toBeNull();
    expect(feasibility.guard).not.toHaveBeenCalled();
  });
  it('requires session-bound CSRF and same origin before authority changes', async () => {
    const own = await session();
    const extras: Record<string, string>[] = [{ 'x-csrf-token': 'invalid' }, { origin: 'https://attacker.invalid' }, { 'sec-fetch-site': 'cross-site' }];
    for (const extra of extras) {
      expect((await POST(request(own, { action: 'prepare', expectedRevision: null }, extra))).status).toBe(403);
    }
    expect(adapter.load).not.toHaveBeenCalled(); expect(await loadAuthority({ query })).toBeNull();
    expect(feasibility.guard).not.toHaveBeenCalled();
  });
  it('does not accept arbitrary contracts/calldata, self-verified flags, broad activation or missing revision', async () => {
    const own = await session();
    for (const input of [{ action: 'activate' }, { action: 'prepare' },
      { action: 'prepare', expectedRevision: null, calls: [{ to: owner.address, value: '100' }] },
      { action: 'prepare', expectedRevision: null, verified: true }]) {
      const response = await POST(request(own, input)); expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'wallet_authority_request_invalid' });
    }
    expect(adapter.load).not.toHaveBeenCalled(); expect(await loadAuthority({ query })).toBeNull();
  });
  it('fails closed with no production adapter and returns private uncached evidence', async () => {
    const own = await session(); adapter.load.mockResolvedValue(null);
    const response = await get(own); expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('private, no-store');
    expect(await response.json()).toMatchObject({ state: 'unconfigured', executionReadiness: 'not-certified' });
    const rejected = await POST(request(own, { action: 'prepare', expectedRevision: null }));
    expect(rejected.status).toBe(409); expect(await rejected.json()).toMatchObject({ code: 'wallet_authority_environment_missing' });
    expect(await loadAuthority({ query })).toBeNull();
  });
  it('persists only a verified encrypted grant and never exposes it through authenticated GET', async () => {
    const own = await session(); await saveStrategyProfile({ query }, authorityProfile(), null, NOW);
    const prepared = await POST(request(own, { action: 'prepare', expectedRevision: null })); expect(prepared.status).toBe(200);
    const review = await prepared.json(), reference = { id: review.review.id, digest: review.review.digest };
    const ready = await POST(request(own, { action: 'verify-owner-actions', ...reference, expectedRevision: review.revision }));
    expect(ready.status).toBe(200); const current = await ready.json();
    const signature = await owner.signTypedData(current.review.delegation.typed);
    const saved = await POST(request(own, { action: 'accept-signature', ...reference, expectedRevision: current.revision, signature }));
    expect(saved.status).toBe(200); expect(JSON.stringify(await saved.json())).not.toContain(signature);
    const fresh = await get(own), dto = await fresh.json(); expect(dto.state).toBe('verified');
    expect(JSON.stringify(dto)).not.toContain(signature); expect(dto).not.toHaveProperty('signatureCiphertext');
    expect((await loadVerifiedAuthorityForRuntime({ query }, NOW))?.signature).toBe(signature);
    expect((await query('SELECT key FROM app_settings ORDER BY key')).rows).toEqual([
      { key: 'wallet:strategy:authority:v1' }, { key: 'wallet:strategy:profile:v1' } ]);
  });
  it('sanitizes raw adapter failures and malformed error codes without storing a grant', async () => {
    const own = await session(), raw = 'https://private:isolated-secret@rpc.invalid/?key=isolated-secret';
    adapter.load.mockRejectedValue(new Error(raw));
    const response = await POST(request(own, { action: 'prepare', expectedRevision: null }));
    expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain('isolated-secret');
    expect(new AuthorityError(raw).code).toBe('wallet_authority_unavailable');
    expect(await loadAuthority({ query })).toBeNull();
  });
  it('blocks new authority preparation before any authority or execution mutation when current costs fail', async () => {
    const own = await session(); await saveStrategyProfile({ query }, authorityProfile(), null, NOW);
    const before = (await query('SELECT key,value,updated_at FROM app_settings ORDER BY key')).rows;
    const auditBefore = (await query('SELECT event,detail FROM audit_events ORDER BY id')).rows;
    feasibility.guard.mockRejectedValue(new AuthorityError('wallet_authority_feasibility_blocked'));
    const response = await POST(request(own, { action: 'prepare', expectedRevision: null }));
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: 'wallet_authority_feasibility_blocked' });
    expect(feasibility.guard).toHaveBeenCalledWith(owner.address.toLowerCase(), 1);
    expect(await loadAuthority({ query })).toBeNull();
    expect((await query('SELECT key,value,updated_at FROM app_settings ORDER BY key')).rows).toEqual(before);
    expect((await query('SELECT event,detail FROM audit_events ORDER BY id')).rows).toEqual(auditBefore);
  });
  it('rechecks feasibility before saving a signature and preserves the pending grant on a blocked result', async () => {
    const own = await session(); await saveStrategyProfile({ query }, authorityProfile(), null, NOW);
    const prepared = await POST(request(own, { action: 'prepare', expectedRevision: null })); const review = await prepared.json();
    const reference = { id: review.review.id, digest: review.review.digest };
    const verified = await POST(request(own, { action: 'verify-owner-actions', ...reference, expectedRevision: review.revision }));
    const ready = await verified.json(), before = await loadAuthority({ query });
    const signature = await owner.signTypedData(ready.review.delegation.typed);
    feasibility.guard.mockRejectedValue(new AuthorityError('wallet_authority_feasibility_blocked'));
    const response = await POST(request(own, { action: 'accept-signature', ...reference, expectedRevision: ready.revision, signature }));
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: 'wallet_authority_feasibility_blocked' });
    expect(await loadAuthority({ query })).toEqual(before); expect(before?.state).toBe('signature-pending');
    expect(before?.signatureCiphertext).toBeNull();
  });
  it('does not verify a pending signature when the review expires while the fresh feasibility check is awaiting', async () => {
    const own = await session(); await saveStrategyProfile({ query }, authorityProfile(), null, NOW);
    const prepared = await POST(request(own, { action: 'prepare', expectedRevision: null })); const review = await prepared.json();
    const reference = { id: review.review.id, digest: review.review.digest };
    const verified = await POST(request(own, { action: 'verify-owner-actions', ...reference, expectedRevision: review.revision }));
    const ready = await verified.json(), before = await loadAuthority({ query });
    const signature = await owner.signTypedData(ready.review.delegation.typed);
    let now = (ready.review.reviewExpiresAt - 1) * 1000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      feasibility.guard.mockClear();
      feasibility.guard.mockImplementationOnce(async () => { now += 2000; return { decision: 'eligible-for-setup' }; });
      const response = await POST(request(own, { action: 'accept-signature', ...reference, expectedRevision: ready.revision, signature }));
      expect(feasibility.guard).toHaveBeenCalledOnce();
      expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: 'wallet_authority_review_expired' });
      expect(await loadAuthority({ query })).toEqual(before);
      expect(before?.state).toBe('signature-pending'); expect(before?.signatureCiphertext).toBeNull();
    } finally { clock.mockRestore(); }
  });
  it('keeps recheck, GET and protective close available when new-entry feasibility is blocked', async () => {
    const own = await session(); await saveStrategyProfile({ query }, authorityProfile(), null, NOW);
    const prepared = await POST(request(own, { action: 'prepare', expectedRevision: null })); const review = await prepared.json();
    const reference = { id: review.review.id, digest: review.review.digest };
    const verified = await POST(request(own, { action: 'verify-owner-actions', ...reference, expectedRevision: review.revision }));
    const ready = await verified.json(), signature = await owner.signTypedData(ready.review.delegation.typed);
    const accepted = await POST(request(own, { action: 'accept-signature', ...reference, expectedRevision: ready.revision, signature }));
    const current = await accepted.json(); expect(current.state).toBe('verified');
    feasibility.guard.mockClear(); feasibility.guard.mockRejectedValue(new AuthorityError('wallet_authority_feasibility_blocked'));
    expect((await get(own)).status).toBe(200);
    expect((await POST(request(own, { action: 'recheck' }))).status).toBe(200);
    const response = await POST(request(own, { action: 'prepare-close', ...reference, expectedRevision: current.revision }));
    expect(response.status).toBe(200); const close = await response.json(); expect(close.state).toBe('closing');
    expect(feasibility.guard).not.toHaveBeenCalled();
    expect((await POST(request(own, { action: 'verify-close', ...reference, expectedRevision: close.revision,
      closeDigest: close.close.digest }))).status).toBe(200);
    expect((await loadAuthority({ query }))?.state).toBe('closed');
  });
  it('protects the read-only feasibility API with owner session, same-origin CSRF and strict input before public reads', async () => {
    const value = { owner: owner.address, chainId: 1 };
    expect((await feasibilityPOST(request(null, value))).status).toBe(401);
    expect((await feasibilityPOST(request(null, value, { authorization: 'Bearer scheduler-only' }))).status).toBe(401);
    const own = await session();
    expect((await feasibilityPOST(request(own, value, { 'x-csrf-token': 'invalid' }))).status).toBe(403);
    expect((await feasibilityPOST(request(own, value, { origin: 'https://attacker.invalid' }))).status).toBe(403);
    expect((await feasibilityPOST(request(own, { ...value, verified: true }))).status).toBe(409);
    expect(feasibility.audit).not.toHaveBeenCalled();
    const before = (await query('SELECT key,value,updated_at FROM app_settings ORDER BY key')).rows;
    const response = await feasibilityPOST(request(own, value));
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('private, no-store');
    expect(await response.json()).toMatchObject({ decision: 'blocked', createdExecutionState: false });
    expect(feasibility.audit).toHaveBeenCalledWith(owner.address, 1);
    expect((await query('SELECT key,value,updated_at FROM app_settings ORDER BY key')).rows).toEqual(before);
    expect(await loadAuthority({ query })).toBeNull();
  });
  it('returns sanitized private failures when feasibility providers fail without creating authority state', async () => {
    const own = await session(), raw = 'https://private:isolated-feasibility-secret@provider.invalid';
    feasibility.audit.mockRejectedValue(new Error(raw));
    const response = await feasibilityPOST(request(own, { owner: owner.address, chainId: 1 }));
    expect(response.status).toBe(503); expect(response.headers.get('cache-control')).toContain('private, no-store');
    const dto = await response.json(); expect(dto.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(dto)).not.toMatch(/isolated-feasibility-secret|provider\.invalid|private:/);
    expect(await loadAuthority({ query })).toBeNull(); expect((await query('SELECT key FROM app_settings')).rows).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError } from '../src/lib/auth';
import { POST } from '../src/app/api/wallet/strategy/valuation/route';
const auth = vi.hoisted(() => ({ requireMutation: vi.fn(), refreshSessionCookie: vi.fn() }));
const valuation = vi.hoisted(() => ({ auditMusdValuation: vi.fn() }));
vi.mock('../src/lib/auth', async original => ({ ...await original<typeof import('../src/lib/auth')>(), ...auth }));
vi.mock('../src/lib/wallet/musd-valuation', () => valuation);
const owner = '0x1111111111111111111111111111111111111111';
const request = (input: unknown) => new Request('https://mirsad.test/api/wallet/strategy/valuation', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
beforeEach(() => {
  vi.clearAllMocks(); auth.requireMutation.mockResolvedValue({ id: 'test-session', csrfToken: 'test-csrf' });
  auth.refreshSessionCookie.mockResolvedValue('test-session=renewed');
  valuation.auditMusdValuation.mockResolvedValue({ version: 1, owner, referenceOnly: true, executionReady: false, createdExecutionState: false });
});
afterEach(() => vi.restoreAllMocks());
describe('authenticated reference valuation endpoint', () => {
  it('uses the authenticated read-only service and returns non-cacheable dated evidence with session renewal', async () => {
    const result = await POST(request({ owner, chainId: 1 }));
    expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toContain('no-store');
    expect(result.headers.get('set-cookie')).toBe('test-session=renewed');
    expect(await result.json()).toMatchObject({ referenceOnly: true, executionReady: false, createdExecutionState: false, csrfToken: 'test-csrf' });
    expect(valuation.auditMusdValuation).toHaveBeenCalledExactlyOnceWith(owner, 1);
  });
  it.each([401, 403])('requires mutation authentication and CSRF before looking up financial references (%s)', async status => {
    auth.requireMutation.mockRejectedValueOnce(new AuthError(status, 'AUTH_REQUIRED', 'Authentication required'));
    expect((await POST(request({ owner, chainId: 1 }))).status).toBe(status);
    expect(valuation.auditMusdValuation).not.toHaveBeenCalled();
  });
  it.each([{ owner, chainId: 8453 }, { owner: '0x' + '0'.repeat(40), chainId: 1 }, { owner, chainId: 1, approve: true },
    { owner, chainId: 1, rpc: 'https://private.invalid' }])('rejects unsupported identity, extra permissions and arbitrary endpoints', async value => {
    expect((await POST(request(value))).status).toBe(400); expect(valuation.auditMusdValuation).not.toHaveBeenCalled();
  });
  it('does not leak provider data or turn a failed reference into zero', async () => {
    valuation.auditMusdValuation.mockRejectedValueOnce(new Error('https://private.invalid/?key=isolated'));
    const result = await POST(request({ owner, chainId: 1 })), text = await result.text();
    expect(result.status).toBe(503); expect(text).not.toContain('private.invalid'); expect(text).not.toContain('balanceRaw');
  });
});

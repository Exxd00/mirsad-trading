import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkHostReadiness } from '../scripts/check-host-readiness.mjs';

const origin = 'https://mirsad.example', commit = 'a'.repeat(40);
afterEach(() => vi.useRealTimers());
describe('anonymous deployment recovery check', () => {
  it('recognizes the actual Vercel pause response without attempting JSON, authentication or financial work', async () => {
    const fetcher = vi.fn(async () => new Response('Payment required\nDEPLOYMENT_DISABLED', {
      status: 402, headers: { 'content-type': 'text/plain', 'x-vercel-error': 'DEPLOYMENT_DISABLED' },
    }));
    const value = await checkHostReadiness({ origin, expectedCommit: commit, fetcher });
    expect(value).toMatchObject({ status: 'blocked', reason: 'deployment_disabled', httpStatus: 402, release: null, financialReadiness: 'not-certified' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]).toEqual([origin + '/api/release', {
      method: 'GET', redirect: 'manual', cache: 'no-store', signal: expect.any(AbortSignal),
    }]);
  });
  it('verifies an exact release while explicitly leaving financial readiness uncertified', async () => {
    const fetcher = vi.fn(async () => Response.json({ version: 'cow-wallet-v1', commit, csrfToken: 'must-never-be-returned' }));
    const value = await checkHostReadiness({ origin, expectedCommit: commit, fetcher });
    expect(value).toMatchObject({ status: 'verified', reason: null, release: { version: 'cow-wallet-v1', commit }, financialReadiness: 'not-certified' });
    expect(JSON.stringify(value)).not.toContain('must-never-be-returned');
    const mismatch = await checkHostReadiness({ origin, expectedCommit: 'b'.repeat(40), fetcher });
    expect(mismatch).toMatchObject({ status: 'unverified', reason: 'release_commit_mismatch' });
  });
  it.each([
    () => new Response(null, { status: 302, headers: { location: 'https://other.example/' } }),
    () => new Response('<html>default landing page</html>', { headers: { 'content-type': 'text/html' } }),
    () => Response.json({ version: 'another-app', commit }),
    () => new Response('{invalid', { headers: { 'content-type': 'application/json' } }),
    () => Response.json({ version: 'cow-wallet-v1', commit, padding: 'x'.repeat(17000) }),
  ])('does not certify a redirect, landing page or invalid/oversized release', async makeResponse => {
    const fetcher = vi.fn(async () => makeResponse());
    const value = await checkHostReadiness({ origin, expectedCommit: commit, fetcher });
    expect(value.status).not.toBe('verified'); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('bounds a stalled provider and sanitizes provider exception text', async () => {
    vi.useFakeTimers();
    const pending = checkHostReadiness({ origin, expectedCommit: commit, timeoutMs: 10, fetcher: () => new Promise(() => undefined) });
    await vi.advanceTimersByTimeAsync(11);
    expect(await pending).toMatchObject({ status: 'unverified', reason: 'host_check_timeout' });
    const failed = await checkHostReadiness({ origin, expectedCommit: commit, fetcher: async () => { throw new Error('private:isolated-secret'); } });
    expect(failed).toMatchObject({ status: 'unverified', reason: 'host_read_unavailable' });
    expect(JSON.stringify(failed)).not.toContain('isolated-secret');
  });
  it.each(['http://mirsad.example', 'https://user:private@mirsad.example', 'https://mirsad.example/path', 'https://mirsad.example/?key=private'])('rejects invalid target configuration before any request', async target => {
    const fetcher = vi.fn();
    await expect(checkHostReadiness({ origin: target, expectedCommit: commit, fetcher })).rejects.toThrow('host_check_input_invalid');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

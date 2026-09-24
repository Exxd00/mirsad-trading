import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign, webcrypto } from 'node:crypto';
import { educationPublicJson, fetchEducationMarkets } from '../src/lib/education/feed';
import { schedulerMessage, SCHEDULER_PUBLIC_KEY, TICK_PATH, verifyScheduler } from '../src/lib/education/scheduler-auth';
import educationWorker, { dispatchEducation } from '../automation/education-scheduler.mjs';
import { AuthError } from '../src/lib/auth';
import { GET, POST } from '../src/app/api/education/[...action]/route';

const api = vi.hoisted(() => ({
  requireSession: vi.fn(), requireMutation: vi.fn(), refreshSessionCookie: vi.fn(),
  initializeEducation: vi.fn(), getEducationReport: vi.fn(), setEducationEnabled: vi.fn(), runEducation: vi.fn(),
}));
vi.mock('../src/lib/auth', async importOriginal => ({ ...(await importOriginal<typeof import('../src/lib/auth')>()),
  requireSession: api.requireSession, requireMutation: api.requireMutation, refreshSessionCookie: api.refreshSessionCookie,
}));
vi.mock('../src/lib/education/store', () => ({ initializeEducation: api.initializeEducation,
  getEducationReport: api.getEducationReport, setEducationEnabled: api.setEducationEnabled,
}));
vi.mock('../src/lib/education/runner', () => ({ runEducation: api.runEducation }));

const NOW = Date.parse('2026-09-24T22:22:00.000Z');
const makeKeys = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: publicKey.export({ format: 'jwk' }) as typeof SCHEDULER_PUBLIC_KEY, privateKey };
};
function signedRequest(keys: ReturnType<typeof makeKeys>, issuedAt = NOW, payload = JSON.stringify({ slot: Math.floor(issuedAt / 300_000) }), url = `https://mirsad-trading.vercel.app${TICK_PATH}`, method = 'POST') {
  const time = String(issuedAt);
  const signature = sign(null, Buffer.from(schedulerMessage(time, payload)), keys.privateKey).toString('base64url');
  const request = new Request(url, { method, headers: { Authorization: `Mirsad-Ed25519 ${signature}`, 'X-Mirsad-Time': time, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: payload } : {}) });
  return { request, payload };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.requireSession.mockResolvedValue({ id: 'education-test-session' });
  api.requireMutation.mockResolvedValue({ id: 'education-test-session' });
  api.refreshSessionCookie.mockResolvedValue('test-session=renewed');
  vi.stubEnv('VERCEL_ENV', 'production');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('educational public market boundary', () => {
  it.each([
    '/api/1.0/orders', '/api/1.0/accounts', '/api/1.0/balances',
    '/api/1.0/public/candles/DOGE-EUR', 'https://example.com/api/1.0/public/tickers',
    'https://reader:secret@revx.revolut.com/api/1.0/public/tickers',
    'https://revx.revolut.com/api/1.0/public/tickers#orders',
  ])('rejects a non-allowlisted path before any fetch: %s', async path => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(educationPublicJson(path, fetcher)).rejects.toThrow('public_path_rejected');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads an allowed public URL with no credentials, no auth headers and no redirect following', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [] }));
    await expect(educationPublicJson('/api/1.0/public/tickers?region=EEA', fetcher)).resolves.toEqual({ data: [] });
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toBe('https://revx.revolut.com/api/1.0/public/tickers?region=EEA');
    expect(options).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store' });
    const headers = new Headers(options?.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
    expect(options?.body).toBeUndefined();
  });

  it('rejects redirect responses and oversized streamed bodies without trusting content-length', async () => {
    const redirect = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 302, headers: { Location: 'https://example.com' } }));
    await expect(educationPublicJson('/api/1.0/public/tickers', redirect)).rejects.toThrow('public_feed_unavailable');
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(256_001)));
    await expect(educationPublicJson('/api/1.0/public/tickers', oversized)).rejects.toThrow('public_feed_too_large');
    expect(redirect).toHaveBeenCalledOnce();
    expect(oversized).toHaveBeenCalledOnce();
  });

  it('keeps valid quotes for exits when candle history fails, and drops ambiguous or non-EEA tickers', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/tickers')) return Response.json({
        metadata: { timestamp: NOW }, data: [
          { symbol: 'BTC/EUR', region: 'EEA', bid: '50000', ask: '50010' },
          { symbol: 'ETH/EUR', region: 'EEA', bid: '2000', ask: '2001' },
          { symbol: 'ETH/EUR', region: 'EEA', bid: '2000', ask: '2001' },
          { symbol: 'SOL/EUR', region: 'UK', bid: '100', ask: '101' },
        ],
      });
      if (url.pathname.endsWith('/configuration/pairs')) return Response.json({ btc: {
        base: 'BTC', quote: 'EUR', base_step: '0.000001', min_order_size: '0.000001', min_order_size_quote: '1', status: 'active',
      } });
      return new Response('', { status: 503 });
    });
    const markets = await fetchEducationMarkets(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(markets).toHaveLength(1);
    expect(markets[0]).toMatchObject({ symbol: 'BTC-EUR', bid: '50000', ask: '50010', quoteAt: new Date(NOW).toISOString(), instrument: { quantityStep: '0.000001', minQuantity: '0.000001', minNotional: '1' } });
    expect(markets[0].candles).toBeUndefined();
    expect(fetcher.mock.calls.every(([input]) => new URL(String(input)).pathname.startsWith('/api/1.0/public/'))).toBe(true);
  });
});

describe('educational scheduler signatures', () => {
  it('accepts only the signed payload, route and method with the correct public key', () => {
    const keys = makeKeys(), { request, payload } = signedRequest(keys);
    expect(verifyScheduler(request, payload, NOW, keys.publicKey)).toBe(true);
    const boundary = Date.parse('2026-09-24T22:24:59.000Z');
    const crossing = signedRequest(keys, boundary);
    expect(verifyScheduler(crossing.request, crossing.payload, boundary + 2000, keys.publicKey)).toBe(false);
    expect(verifyScheduler(request, payload, NOW, makeKeys().publicKey)).toBe(false);
    expect(verifyScheduler(request, `${payload} `, NOW, keys.publicKey)).toBe(false);
    expect(verifyScheduler(request, payload.slice(0, -1) + ',"enabled":true}', NOW, keys.publicKey)).toBe(false);
    expect(verifyScheduler(new Request('https://mirsad-trading.vercel.app/api/education/settings', request), payload, NOW, keys.publicKey)).toBe(false);
    const wrongMethod = signedRequest(keys, NOW, payload, `https://mirsad-trading.vercel.app${TICK_PATH}`, 'GET');
    expect(verifyScheduler(wrongMethod.request, payload, NOW, keys.publicKey)).toBe(false);
  });

  it('rejects stale and far-future signatures, including otherwise correctly signed messages', () => {
    const keys = makeKeys();
    for (const issuedAt of [NOW - 120_001, NOW + 5_001]) {
      const { request, payload } = signedRequest(keys, issuedAt);
      expect(verifyScheduler(request, payload, NOW, keys.publicKey)).toBe(false);
    }
    const { request, payload } = signedRequest(keys, NOW - 90_000);
    expect(verifyScheduler(request, payload, NOW, keys.publicKey)).toBe(true);
  });

  it('rejects mismatched slots and extra fields even with a valid signature', () => {
    const keys = makeKeys(), slot = Math.floor(NOW / 300_000);
    for (const payload of [JSON.stringify({ slot: slot + 1 }), JSON.stringify({ slot, enabled: true }), 'null', '[]']) {
      const signed = signedRequest(keys, NOW, payload);
      expect(verifyScheduler(signed.request, payload, NOW, keys.publicKey)).toBe(false);
    }
  });

  it('verifies the real Worker WebCrypto signature with the site verifier and submits only the fixed tick payload', async () => {
    vi.stubGlobal('crypto', webcrypto);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const keys = makeKeys();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, options) => {
      expect(String(input)).toBe('https://mirsad-trading.vercel.app/api/education/tick');
      expect(options).toMatchObject({ method: 'POST', redirect: 'manual' });
      const body = String(options?.body), request = new Request(String(input), options);
      expect(JSON.parse(body)).toEqual({ slot: Math.floor(NOW / 300_000) });
      expect(verifyScheduler(request, body, NOW, keys.publicKey)).toBe(true);
      return Response.json({ ok: true, status: 'completed', orders: 0 });
    });
    await expect(dispatchEducation({ EDUCATION_SCHEDULER_SIGNING_KEY_V1: JSON.stringify(keys.privateKey.export({ format: 'jwk' })) }, NOW, fetcher)).resolves.toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not dispatch without a signing key, rejects redirect/oversized responses, and exposes no public runner', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const keys = makeKeys(), env = { EDUCATION_SCHEDULER_SIGNING_KEY_V1: JSON.stringify(keys.privateKey.export({ format: 'jwk' })) };
    const unused = vi.fn<typeof fetch>();
    await expect(dispatchEducation({}, NOW, unused)).rejects.toThrow('education_scheduler_not_configured');
    expect(unused).not.toHaveBeenCalled();
    const redirect = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 307 }));
    await expect(dispatchEducation(env, NOW, redirect)).rejects.toThrow('education_site_http_307');
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(4097)));
    await expect(dispatchEducation(env, NOW, oversized)).rejects.toThrow('education_response_too_large');
    expect((await educationWorker.fetch()).status).toBe(404);
  });
});

describe('educational API entry points', () => {
  const context = (action: string) => ({ params: Promise.resolve({ action: [action] }) });
  const post = (action: string, data: unknown, headers: Record<string, string> = {}) => new Request(`https://mirsad-trading.vercel.app/api/education/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data),
  });

  it('rejects unsigned cron requests before invoking any state, session or execution operation', async () => {
    const response = await POST(post('tick', { slot: Math.floor(NOW / 300_000) }), context('tick'));
    expect(response.status).toBe(401);
    expect(api.runEducation).not.toHaveBeenCalled();
    expect(api.requireMutation).not.toHaveBeenCalled();
    expect(api.getEducationReport).not.toHaveBeenCalled();
  });

  it('requires authenticated report access and owner mutation authorization before touching stored state', async () => {
    api.requireSession.mockRejectedValueOnce(new AuthError(401, 'AUTH_REQUIRED', 'Session required'));
    expect((await GET(new Request('https://mirsad-trading.vercel.app/api/education/report'), context('report'))).status).toBe(401);
    expect(api.getEducationReport).not.toHaveBeenCalled();
    api.requireMutation.mockRejectedValueOnce(new AuthError(403, 'CSRF_REQUIRED', 'CSRF required'));
    expect((await POST(post('settings', { enabled: true }), context('settings'))).status).toBe(403);
    expect(api.setEducationEnabled).not.toHaveBeenCalled();
  });

  it('blocks preview writes and rejects arbitrary settings even for an authorized owner', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    expect((await POST(post('run', {}), context('run'))).status).toBe(403);
    expect(api.runEducation).not.toHaveBeenCalled();
    vi.stubEnv('VERCEL_ENV', 'production');
    expect((await POST(post('settings', { enabled: true, riskFraction: '1' }), context('settings'))).status).toBe(400);
    expect(api.setEducationEnabled).not.toHaveBeenCalled();
  });
});

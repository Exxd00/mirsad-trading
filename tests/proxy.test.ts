import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
// The installed release still exports the testing helper under its older name.
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { config, proxy } from '../src/proxy';

afterEach(() => vi.unstubAllEnvs());

describe('per-request content security policy', () => {
  it('creates unique unpredictable nonces, overrides injected headers, and passes the same policy to Next and the browser', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const request = new NextRequest('https://private.example/login', { headers: { 'x-nonce': 'attacker-controlled', 'content-security-policy': "script-src * 'unsafe-inline'" } });
    const first = proxy(request), second = proxy(request);
    const nonce = first.headers.get('x-middleware-request-x-nonce');
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(nonce).not.toBe(second.headers.get('x-middleware-request-x-nonce'));
    const policy = first.headers.get('content-security-policy')!;
    expect(policy).toContain(`'nonce-${nonce}'`);
    expect(policy).toBe(first.headers.get('x-middleware-request-content-security-policy'));
    expect(policy).not.toContain('attacker-controlled');
    const scriptPolicy = policy.split('; ').find(value => value.startsWith('script-src '))!;
    expect(scriptPolicy).not.toContain('unsafe-inline');
    expect(scriptPolicy).not.toContain('unsafe-eval');
    expect(scriptPolicy).toContain("'strict-dynamic'");
    expect(policy).toContain("script-src-attr 'none'");
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(first.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });
  it('permits eval only in development, while retaining nonce-based script protection', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const policy = proxy(new NextRequest('http://localhost:3000')).headers.get('content-security-policy')!;
    expect(policy).toContain("'unsafe-eval'");
    expect(policy).toMatch(/script-src 'self' 'nonce-/);
  });
  it('covers private pages, login and direct API paths but leaves static PWA assets outside dynamic nonce rendering', () => {
    for (const url of ['/', '/simulation', '/login', '/api/dashboard', '/api/orders/confirm', '/api/auth/csrf']) {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(true);
    }
    for (const url of ['/_next/static/chunk.js', '/sw.js', '/offline.html', '/manifest.webmanifest', '/icon-192.png']) {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(false);
    }
  });
});

import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Per-response CSP nonces are passed into Next's dynamic renderer so its
 * framework and hydration scripts receive the same nonce as the response CSP.
 * Authentication remains enforced by every private page and API handler.
 */
export function proxy(request: NextRequest) {
  const nonce = randomBytes(32).toString('base64');
  const development = process.env.NODE_ENV === 'development';
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    "script-src-attr 'none'",
    // Chart/SVG styles and React style attributes require this CSS-only allowance.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "worker-src 'self'",
  ].join('; ');

  const forwarded = new Headers(request.headers);
  // Never trust a nonce or CSP supplied by the caller.
  forwarded.set('x-nonce', nonce);
  forwarded.set('Content-Security-Policy', policy);
  const response = NextResponse.next({ request: { headers: forwarded } });
  response.headers.set('Content-Security-Policy', policy);
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  response.headers.set('Pragma', 'no-cache');
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|icon.svg|icon-192.png|icon-512.png|offline.html).*)'],
};

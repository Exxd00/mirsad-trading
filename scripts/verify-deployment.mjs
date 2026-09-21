// Anonymous HTTP checks only. No account credentials or valid order are used.
import assert from 'node:assert/strict';

const base = new URL(process.argv[2]);
assert.equal(base.protocol, 'https:', 'Use the deployed HTTPS origin');
const read = (path, init = {}) => fetch(new URL(path, base), {
  redirect: 'manual', signal: AbortSignal.timeout(20000), ...init,
});
const rows = [];
for (const path of ['/', '/simulation']) {
  const response = await read(path);
  assert.equal(response.status, 307, `${path} must redirect before rendering private data`);
  assert.equal(new URL(response.headers.get('location'), base).pathname, '/login');
  rows.push({ path, status: response.status, destination: '/login' });
}
for (const path of ['/api/session', '/api/dashboard', '/api/market?symbol=BTC-EUR&interval=15', '/api/settings']) {
  const response = await read(path);
  assert.equal(response.status, 401, `${path} must reject an anonymous reader`);
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  rows.push({ path, status: response.status, noStore: true });
}
const confirm = await read('/api/orders/confirm', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base.origin }, body: '{}',
});
assert.equal(confirm.status, 401, 'An anonymous empty confirmation must stop at authentication');
rows.push({ path: '/api/orders/confirm (anonymous empty request)', status: confirm.status });
const nonces = [];
for (let i = 0; i < 2; i++) {
  const response = await read('/login');
  assert.equal(response.status, 200);
  const csp = response.headers.get('content-security-policy') || '';
  const scriptsPolicy = csp.split(';').find(part => part.trim().startsWith('script-src ')) || '';
  assert.doesNotMatch(scriptsPolicy, /unsafe-inline|unsafe-eval/);
  const nonce = scriptsPolicy.match(/'nonce-([^']+)'/)?.[1];
  assert.ok(nonce, 'Production HTML requires a nonce');
  const html = await response.text();
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map(match => match[0]);
  assert.ok(scripts.length > 0);
  assert.ok(scripts.every(tag => tag.includes(`nonce="${nonce}"`)), 'All hydration scripts must match CSP');
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  nonces.push(nonce);
}
assert.notEqual(nonces[0], nonces[1], 'Responses must not reuse a nonce');
const csrf = await read('/api/auth/csrf');
assert.equal(csrf.status, 200);
const cookie = csrf.headers.get('set-cookie') || '';
for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(cookie.includes(flag));
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), origin: base.origin, rows,
  login: '200; fresh nonce, matching scripts, no unsafe script directives, no-store',
  loginCsrfCookie: 'Secure; HttpOnly; SameSite=Strict',
  scope: 'Anonymous boundaries only; no authenticated cloud session or broker access verified',
}, null, 2));

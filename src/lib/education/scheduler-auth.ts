import 'server-only';
import { createPublicKey, verify } from 'node:crypto';

// Verification material only. The matching private key is a Cloudflare secret
// used exclusively for this site's educational scheduler, never a broker key.
export const SCHEDULER_PUBLIC_KEY = {
  kty: 'OKP', crv: 'Ed25519', x: '2tqLr_Mnr8-lhYGA3YckHpGcdl455uoVtNpwUFylT_c',
};
export const TICK_PATH = '/api/education/tick';
export function schedulerMessage(issuedAt: string, body: string) {
  return `mirsad-education-v1\nPOST\n${TICK_PATH}\n${issuedAt}\n${body}`;
}
export function verifyScheduler(request: Request, body: string, now = Date.now(), publicKey = SCHEDULER_PUBLIC_KEY): boolean {
  const issuedAt = request.headers.get('x-mirsad-time') ?? '';
  const signature = request.headers.get('authorization')?.match(/^Mirsad-Ed25519 ([A-Za-z0-9_-]{86})$/)?.[1];
  if (request.method !== 'POST' || new URL(request.url).pathname !== TICK_PATH || !/^\d{13}$/.test(issuedAt) || !signature || Buffer.byteLength(body) > 512) return false;
  const age = now - Number(issuedAt);
  if (!Number.isSafeInteger(Number(issuedAt)) || age > 120_000 || age < -5_000) return false;
  try {
    const parsed = JSON.parse(body);
    if (Object.keys(parsed).length !== 1 || !Number.isSafeInteger(parsed.slot) || parsed.slot !== Math.floor(Number(issuedAt) / 300_000) || parsed.slot !== Math.floor(now / 300_000)) return false;
    return verify(null, Buffer.from(schedulerMessage(issuedAt, body)), createPublicKey({ key: publicKey, format: 'jwk' }), Buffer.from(signature, 'base64url'));
  } catch { return false; }
}

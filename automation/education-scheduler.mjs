// Private cron initiator. The site owns the educational ledger and execution.
// No market/account/order provider is called from this Worker.
const ENDPOINT = 'https://mirsad-trading.vercel.app/api/education/tick';
const PATH = '/api/education/tick';
function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function dispatchEducation(env, now = Date.now(), fetcher = fetch) {
  if (!env.EDUCATION_SCHEDULER_SIGNING_KEY_V1) throw new Error('education_scheduler_not_configured');
  const issuedAt = String(now), body = JSON.stringify({ slot: Math.floor(now / 300_000) });
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env.EDUCATION_SCHEDULER_SIGNING_KEY_V1), { name: 'Ed25519' }, false, ['sign']);
  const message = `mirsad-education-v1\nPOST\n${PATH}\n${issuedAt}\n${body}`;
  const signature = base64url(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(message)));
  const response = await fetcher(ENDPOINT, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(55_000), headers: {
    'Content-Type': 'application/json', 'X-Mirsad-Time': issuedAt, Authorization: `Mirsad-Ed25519 ${signature}`,
  }, body });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`education_site_http_${response.status}`); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('education_empty_response');
  const chunks = []; let length = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > 4096) { await reader.cancel(); throw new Error('education_response_too_large'); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const result = JSON.parse(new TextDecoder().decode(bytes));
  if (result.ok !== true) throw new Error('education_run_failed');
  console.log(JSON.stringify({ event: 'education.tick', at: now, status: result.busy ? 'busy' : result.status, replayed: result.replayed === true, orders: result.orders ?? 0 }));
  return result;
}
export default {
  async scheduled(_controller, env) { await dispatchEducation(env); },
  async fetch() { return new Response('Not found', { status: 404 }); },
};

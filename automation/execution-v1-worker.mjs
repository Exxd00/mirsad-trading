// Cloudflare scheduler + persistent deadline wakeups; the Next.js host owns the
// strategy cycle. Never sleep for 60 seconds inside a request or cron callback.
async function authorized(request, env) {
  if (!env.EXECUTION_SCHEDULER_TOKEN) return false;
  const encoder = new TextEncoder();
  const hash = async value => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  const [a, b] = await Promise.all([hash(request.headers.get('authorization') || ''), hash(`Bearer ${env.EXECUTION_SCHEDULER_TOKEN}`)]);
  let difference = 0; for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i]; return difference === 0;
}
async function dispatch(env, action, payload = {}) {
  if (!env.EXECUTION_SCHEDULER_TOKEN) throw new Error('scheduler_auth_not_configured');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('scheduler_timeout')), 55000);
  try {
    const response = await fetch(`https://mirsad-trading.vercel.app/api/execution/${action}`, {
      // workerd supports manual/follow; reject redirects so the credential
      // never follows a different destination.
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.EXECUTION_SCHEDULER_TOKEN}` }, body: JSON.stringify(payload),
    });
    if (!response.ok && response.status !== 409) throw new Error(`scheduler_http_${response.status}`);
    return await response.json();
  } finally { clearTimeout(timeout); }
}
export default {
  async scheduled(_event, env) {
    const result = await dispatch(env, 'tick');
    console.log(JSON.stringify({ type: 'execution.v1.tick', status: result.status, reason: result.reason ?? null }));
  },
  async fetch(request, env) {
    if (!await authorized(request, env)) return new Response('Unauthorized', { status: 401 });
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/schedule') return new Response('Not found', { status: 404 });
    const text = await request.text(); if (text.length > 512) return new Response('Too large', { status: 413 });
    let data; try { data = JSON.parse(text); } catch { return new Response('Invalid JSON', { status: 400 }); }
    if (!data || typeof data !== 'object') return new Response('Invalid deadline', { status: 400 });
    if (!/^[a-f0-9]{64}$/.test(data.key) || !Number.isSafeInteger(data.expiresAt)) return new Response('Invalid deadline', { status: 400 });
    return env.DEADLINES.getByName(data.key).fetch(new Request('https://deadline.internal/schedule', { method: 'POST', body: JSON.stringify(data) }));
  },
};
export class OrderDeadline {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    const job = await request.json(), old = await this.ctx.storage.get('job');
    if (old && old.key !== job.key) return new Response('Key mismatch', { status: 409 });
    const value = old ? { ...old, expiresAt: Math.min(old.expiresAt, job.expiresAt) } : job;
    await this.ctx.storage.put('job', value);
    await this.ctx.storage.setAlarm(Math.max(Date.now(), value.expiresAt * 1000));
    return Response.json({ scheduled: true, expiresAt: value.expiresAt });
  }
  async alarm() {
    const job = await this.ctx.storage.get('job'); if (!job) return;
    try {
      const result = await dispatch(this.env, 'deadline', { key: job.key });
      console.log(JSON.stringify({ type: 'execution.v1.deadline', status: result.status, reason: result.reason ?? null, retryAt: result.retryAt ?? null }));
      if (result.retryAt) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, result.retryAt * 1000));
      else if (result.reason === 'order_api_not_connected') await this.ctx.storage.setAlarm(Date.now() + 60000);
      else await this.ctx.storage.delete('job');
    } catch (error) {
      console.warn(JSON.stringify({ type: 'execution.v1.deadline_retry', error: error instanceof Error ? error.name : 'unknown', reason: error instanceof Error ? error.message.slice(0, 200) : 'deadline_dispatch_failed' }));
      await this.ctx.storage.setAlarm(Date.now() + 5000);
    }
  }
}

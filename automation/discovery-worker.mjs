// Independent paper discovery clock. No broker bindings or execution routes.
const TICK_URL = 'https://mirsad-trading.vercel.app/api/discovery/tick';
const TIMEOUT_MS = 20000;

async function tick(env) {
  const token = env.DISCOVERY_SCHEDULER_TOKEN;
  if (typeof token !== 'string' || !token || /\s/.test(token)) return { status: 'not_configured' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(TICK_URL, {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
    });
    // Do not parse or log source data, errors, headers, or credentials. The
    // application owns its durable run result and Sheets outbox.
    void response.body?.cancel().catch(() => undefined);
    if (response.status >= 300 && response.status < 400) return { status: 'redirect_rejected' };
    if (response.status === 409) return { status: 'busy' };
    if (response.status === 401 || response.status === 403) return { status: 'unauthorized' };
    if (response.status === 429) return { status: 'rate_limited' };
    return { status: response.ok ? 'accepted' : 'upstream_error' };
  } catch {
    return { status: controller.signal.aborted ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  async scheduled(_event, env) {
    // One attempt per invocation. Retry on the next scheduled minute only;
    // duplicate deliveries are fenced by the application's database lease.
    const result = await tick(env);
    console.log(JSON.stringify({ type: 'discovery.tick', status: result.status }));
    return result;
  },
  async fetch(request) {
    if (new URL(request.url).pathname !== '/health') return new Response('Not found', { status: 404 });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
    return Response.json({ status: 'ok', mode: 'paper', financialMutations: false }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  },
};

// Redeploying this target removes its old cron triggers. Even a stale scheduled
// invocation cannot dispatch a request or execute either generation of engine.
export default {
  async scheduled() { return { status: 'retired' }; },
  async fetch() { return new Response('Legacy scheduler retired', { status: 410 }); },
};

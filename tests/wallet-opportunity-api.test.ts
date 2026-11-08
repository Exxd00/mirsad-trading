import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, ensureSchema, query } from '../src/lib/db';
import { hashPassword, issueLoginCsrf, login, sessionCookieName } from '../src/lib/auth';
import { CONFIG } from '../src/lib/execution/v1/model';
import { initialState, SqlJournal } from '../src/lib/execution/v1/journal';
import { planBuy } from '../src/lib/execution/v1/planner';
import { evaluateRisk } from '../src/lib/execution/v1/risk';
import { installWalletExecutionSource, walletExecutionSource } from '../src/lib/wallet/execution-connection';
import { STRATEGY_SELECTION_KEY } from '../src/lib/wallet/strategy-selection';
import { GET, POST } from '../src/app/api/wallet/strategy/route';
import { NOW, account, instrument, quote, signal } from './execution-fixtures';

const origin = 'http://localhost:3000', url = origin + '/api/wallet/strategy';
const password = 'isolated-opportunity-api-password-A8!', scheduler = 'isolated-scheduler-token-for-selection-only';
const runtimeKey = `execution:v1:${CONFIG.accountId}:state`, lockKey = `execution:v1:${CONFIG.accountId}:lock`;
type Login = Awaited<ReturnType<typeof login>>;
async function session(): Promise<Login> {
  const csrf = issueLoginCsrf();
  return login(password, new Request(origin + '/api/auth/login', { method: 'POST', headers: {
    origin, cookie: csrf.cookie.split(';')[0], 'x-csrf-token': csrf.csrfToken,
  } }));
}
function request(own: Login | null, input: unknown = { action: 'set-selection', mode: 'opportunities', expectedRevision: null },
  change: { origin?: string | null; csrf?: string | null; cookie?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { origin, 'content-type': 'application/json' };
  if (own) { headers.cookie = `${sessionCookieName()}=${own.sessionToken}`; headers['x-csrf-token'] = own.csrfToken; }
  for (const field of ['origin', 'cookie'] as const) {
    if (change[field] === null) delete headers[field]; else if (change[field] !== undefined) headers[field] = change[field];
  }
  if (change.csrf === null) delete headers['x-csrf-token']; else if (change.csrf !== undefined) headers['x-csrf-token'] = change.csrf;
  Object.assign(headers, change.headers);
  return new Request(url, { method: 'POST', headers, body: JSON.stringify(input) });
}
function reload(own: Login) { return GET(new Request(url, { headers: { cookie: `${sessionCookieName()}=${own.sessionToken}` } })); }
async function put(key: string, value: unknown) {
  await query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [key, JSON.stringify(value)]);
}
async function settings() { return (await query('SELECT key,value,updated_at FROM app_settings ORDER BY key')).rows; }
async function selection() { return (await query('SELECT value FROM app_settings WHERE key=$1', [STRATEGY_SELECTION_KEY])).rows; }
async function selectionAudit() { return (await query("SELECT detail FROM audit_events WHERE event='wallet.selection.changed' ORDER BY id")).rows; }

beforeAll(async () => {
  await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL', ''); vi.stubEnv('VERCEL_ENV', '');
  vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); vi.stubEnv('APP_ORIGIN', origin);
  vi.stubEnv('MIRSAD_RETIRE_LEGACY_CONNECTION', undefined); vi.stubEnv('EXECUTION_SCHEDULER_TOKEN', scheduler);
  vi.stubEnv('INITIAL_PASSWORD_HASH', await hashPassword(password)); await ensureSchema();
});
beforeEach(async () => {
  await query('TRUNCATE app_settings, app_sessions, app_owner, auth_rate_limits, audit_events, order_intents RESTART IDENTITY');
  installWalletExecutionSource(null);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network in isolated opportunity API test'); }));
});
afterEach(() => {
  try { expect(fetch).not.toHaveBeenCalled(); }
  finally { installWalletExecutionSource(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });

describe('owner mutation authentication for opportunity selection', () => {
  it('requires the owner session and never accepts a scheduler bearer as owner authority', async () => {
    const before = await settings();
    const credentials: Record<string, string>[] = [{}, { authorization: `Bearer ${scheduler}` }];
    for (const headers of credentials) {
      const response = await POST(request(null, undefined, { headers }));
      expect(response.status).toBe(401); expect(await response.json()).toMatchObject({ code: 'authentication_required' });
    }
    expect(await settings()).toEqual(before); expect(await selectionAudit()).toEqual([]);
  });
  it.each(['missing-csrf', 'wrong-csrf', 'missing-origin', 'foreign-origin', 'cross-site'] as const)(
    'rejects %s even with a real owner session, without persisting configuration', async rejected => {
      const own = await session(), before = await settings();
      const change = rejected === 'missing-csrf' ? { csrf: null } : rejected === 'wrong-csrf' ? { csrf: 'x'.repeat(43) }
        : rejected === 'missing-origin' ? { origin: null } : rejected === 'foreign-origin' ? { origin: 'https://attacker.invalid' }
          : { headers: { 'sec-fetch-site': 'cross-site' } };
      const response = await POST(request(own, undefined, change));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: rejected.includes('csrf') ? 'csrf_rejected' : 'origin_rejected' });
      expect(await settings()).toEqual(before); expect(await selectionAudit()).toEqual([]);
    });
  it('binds the CSRF token to the authenticated session', async () => {
    const first = await session(), second = await session();
    const response = await POST(request(first, undefined, { csrf: second.csrfToken }));
    expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ code: 'csrf_rejected' });
    expect(await selection()).toEqual([]);
  });
});

describe('strict persisted opportunities mode without financial activation', () => {
  it.each([
    { action: 'set-selection', mode: 'automatic', expectedRevision: null },
    { action: 'set-selection', mode: 'opportunities' },
    { action: 'set-selection', mode: 'opportunities', expectedRevision: 0 },
    { action: 'set-selection', mode: 'opportunities', expectedRevision: 1.5 },
    { action: 'set-selection', mode: 'opportunities', expectedRevision: Number.MAX_SAFE_INTEGER },
    { action: 'set-selection', mode: 'opportunities', expectedRevision: '1' },
    { action: 'set-selection', mode: 'opportunities', expectedRevision: null, entriesEnabled: true },
    { action: 'set-selection', mode: 'opportunities', expectedRevision: null, markets: ['PAPER-EUR'] },
    { action: 'activate', mode: 'opportunities', expectedRevision: null },
  ])('rejects malformed or self-authorizing input %# before acquiring the account lease', async input => {
    const own = await session(), before = await settings(), response = await POST(request(own, input));
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: 'wallet_strategy_selection_invalid' });
    expect(await settings()).toEqual(before); expect(await selectionAudit()).toEqual([]);
  });
  it('persists exactly the owner choice with no source and preserves all funding, grants, profiles, watchlists and switches', async () => {
    await put('wallet:strategy:watchlist', []); await put('watchlist', ['OLD-EUR']);
    await put(runtimeKey, { ...initialState(), executionArmed: false }); await put('live_enabled', false);
    await put('wallet:offline-trial:84532:v1:local', { paused: true, authorized: false });
    await put('wallet:strategy:grant:isolated-marker', { status: 'unverified', marker: 'preserve-only-not-a-grant' });
    await put('discovery:wallet:v1:cohort', ['PAPER-EUR']);
    const own = await session(), before = await settings(), response = await POST(request(own)), value = await response.json();
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('private, no-store');
    expect(response.headers.get('set-cookie')).toContain(sessionCookieName());
    expect(value).toMatchObject({ marketSelection: { status: 'configured', mode: 'opportunities', revision: 1 },
      selectedMarkets: { status: 'valid', symbols: [] }, sourceInstallation: 'absent', profile: { status: 'missing' },
      executionReadiness: 'not-checked-by-this-endpoint' });
    expect(value.marketSelection.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
    expect((await settings()).filter(row => row.key !== STRATEGY_SELECTION_KEY && row.key !== lockKey)).toEqual(before);
    expect(await query('SELECT key FROM app_settings WHERE key=$1', ['wallet:strategy:profile:v1'])).toMatchObject({ rows: [] });
    expect(walletExecutionSource()).toBeNull();
    const raw = JSON.stringify(value);
    for (const privateValue of [own.sessionToken, own.csrfToken, password, 'preserve-only-not-a-grant']) expect(raw).not.toContain(privateValue);
    const saved = (await selection())[0] as { value: unknown };
    expect(saved.value).toEqual({ storageVersion: 1, revision: 1, updatedAt: value.marketSelection.updatedAt,
      policy: { schemaVersion: 1, accountId: CONFIG.accountId, strategyVersion: CONFIG.strategyVersion, mode: 'opportunities' } });
    expect(await selectionAudit()).toEqual([{ detail: { mode: 'opportunities', revision: 1, at: value.marketSelection.updatedAt } }]);
    const after = await settings(), freshPage = await reload(own);
    expect(freshPage.status).toBe(200); expect((await freshPage.json()).marketSelection).toEqual(value.marketSelection);
    expect(await settings()).toEqual(after);
  });
  it('uses revision CAS and keeps stale retries from overwriting the winning choice', async () => {
    const own = await session(); expect((await POST(request(own))).status).toBe(200);
    for (const expectedRevision of [null, 2]) {
      const stale = await POST(request(own, { action: 'set-selection', mode: 'manual', expectedRevision }));
      expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: 'wallet_strategy_selection_revision_conflict' });
    }
    expect((await selectionAudit()).length).toBe(1);
    const changed = await POST(request(own, { action: 'set-selection', mode: 'manual', expectedRevision: 1 }));
    expect(changed.status).toBe(200); expect((await changed.json()).marketSelection).toMatchObject({ mode: 'manual', revision: 2 });
    expect((await (await reload(own)).json()).marketSelection).toMatchObject({ mode: 'manual', revision: 2 });
    expect((await selectionAudit()).length).toBe(2); expect(walletExecutionSource()).toBeNull();
  });
  it('allows one winning authenticated edit when two initial choices race', async () => {
    const own = await session();
    const responses = await Promise.all(['opportunities', 'manual'].map(mode => POST(request(own,
      { action: 'set-selection', mode, expectedRevision: null }))));
    expect(responses.map(value => value.status).sort()).toEqual([200, 409]);
    const winner = await responses.find(value => value.status === 200)!.json();
    const loser = await responses.find(value => value.status === 409)!.json();
    expect(['wallet_selection_busy', 'wallet_strategy_selection_revision_conflict']).toContain(loser.code);
    expect((await (await reload(own)).json()).marketSelection).toMatchObject({ mode: winner.marketSelection.mode, revision: 1 });
    expect((await selectionAudit()).length).toBe(1); expect(walletExecutionSource()).toBeNull();
  });
  it('leaves a missing policy as manual on reload without creating a record or inheriting a historical watchlist', async () => {
    await put('watchlist', ['OLD-EUR']); const own = await session(), before = await settings();
    const response = await reload(own);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({
      marketSelection: { status: 'missing', mode: 'manual', revision: null }, selectedMarkets: { status: 'missing', symbols: [] },
    });
    expect(await selection()).toEqual([]); expect(await settings()).toEqual(before);
  });
});

describe('selection edits serialize with execution ownership', () => {
  it('rejects an edit while another account lease is active without stealing it', async () => {
    const own = await session(), journal = new SqlJournal(), lease = (await journal.acquire(CONFIG.accountId))!;
    try {
      const before = await settings(), response = await POST(request(own));
      expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: 'wallet_selection_busy' });
      expect(await selection()).toEqual([]); expect(await settings()).toEqual(before);
      expect(await journal.state(lease)).toEqual(initialState()); expect(await selectionAudit()).toEqual([]);
    } finally { await journal.release(lease); }
  });
  it('rejects a durable unsettled source-write claim after its lease is released, then permits an edit once reconciled', async () => {
    const own = await session(), journal = new SqlJournal(), lease = (await journal.acquire(CONFIG.accountId))!;
    const state = initialState(); state.executionArmed = true;
    const snapshot = account(), risk = evaluateRisk(state.risk, snapshot.trades, snapshot.equityHistory, true, NOW);
    const intent = planBuy(snapshot, signal(), instrument(), quote(), risk, NOW).intent;
    if (!intent) throw new Error('isolated_entry_fixture_invalid');
    const writeId = `submit:${intent.key}`;
    try {
      await journal.save(lease, state); expect(await journal.begin(lease, intent, NOW)).toBe(true);
      expect(await journal.claimSourceWrite(lease, { id: writeId, decisionKey: intent.key, symbol: intent.symbol,
        kind: 'submit', sourceOrderId: null, startedAt: NOW, settledAt: null })).toBe(true);
    } finally { await journal.release(lease); }
    const before = (await settings()).filter(row => row.key !== lockKey), blocked = await POST(request(own));
    expect(blocked.status).toBe(409); expect(await blocked.json()).toMatchObject({ code: 'wallet_selection_busy' });
    expect((await settings()).filter(row => row.key !== lockKey)).toEqual(before);
    expect(await selection()).toEqual([]); expect(await selectionAudit()).toEqual([]);
    const reconcile = (await journal.acquire(CONFIG.accountId))!;
    try { await journal.settleSourceWrite(reconcile, writeId, NOW + 1); }
    finally { await journal.release(reconcile); }
    const accepted = await POST(request(own));
    expect(accepted.status).toBe(200); expect((await accepted.json()).marketSelection).toMatchObject({ mode: 'opportunities', revision: 1 });
    expect((await query('SELECT value FROM app_settings WHERE key=$1', [runtimeKey])).rows).toEqual([{ value: state }]);
    expect(walletExecutionSource()).toBeNull();
  });
});

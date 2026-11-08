import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../src/lib/db';
import { hashPassword, issueLoginCsrf, login, sessionCookieName } from '../src/lib/auth';
import { CONFIG } from '../src/lib/execution/v1/model';
import type { WalletVenueSource } from '../src/lib/execution/v1/wallet-venue';
import { installWalletExecutionSource, walletExecutionSource } from '../src/lib/wallet/execution-connection';
import { STRATEGY_PROFILE_KEY } from '../src/lib/wallet/strategy-profile';
import { walletStrategySetup } from '../src/lib/wallet/strategy-setup';
import { GET } from '../src/app/api/wallet/strategy/route';

const NOW = Math.floor(Date.now() / 1000), password = 'isolated-wallet-setup-password-A8!';
const executionToken = 'isolated-execution-scheduler-token-32', discoveryToken = 'isolated-discovery-scheduler-token-32';
const activeKey = 'wallet:strategy:watchlist', runtimeKey = `execution:v1:${CONFIG.accountId}:state`;
const addr = (digit: string) => '0x' + digit.repeat(40);
const profile = () => ({ schemaVersion: 1, kind: 'owner-strategy-profile', accountId: CONFIG.accountId,
  strategyVersion: CONFIG.strategyVersion, chainId: 84532, owner: addr('1'), executor: addr('2'),
  quoteToken: addr('3'), quoteDecimals: 6,
  markets: [{ symbol: 'AAA-EUR', baseToken: addr('4'), baseDecimals: 18, quoteToken: addr('3') }],
  accountingCurrency: 'EUR', conversion: { quoteUnit: 'USDC', sourceId: 'isolated-fx-source',
    methodologyReference: 'urn:mirsad:isolated-fx:v1', evidenceReference: 'https://example.invalid/isolated-fx-evidence' },
  authority: { grantReference: 'urn:mirsad:isolated-grant:v1', revocationReference: 'urn:mirsad:isolated-revocation:v1',
    startsAt: NOW - 60, expiresAt: NOW + 3600,
    scope: { recipient: addr('1'), contracts: [addr('5')], tokens: [addr('3'), addr('4')],
      actions: ['limit-entry', 'cancel-remainder', 'managed-exit'] } },
  implementation: { kind: 'cow-candidate', version: 'isolated-candidate-v1', status: 'inactive' } });
const envelope = (value: unknown = profile()) => ({ storageVersion: 1, revision: 3, profile: value });
async function put(key: string, value: unknown) {
  await db.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',
    [key, JSON.stringify(value)]);
}
async function sessionRequest() {
  const csrf = issueLoginCsrf();
  const own = await login(password, new Request('http://localhost:3000/api/auth/login', { method: 'POST', headers: {
    origin: 'http://localhost:3000', cookie: csrf.cookie.split(';')[0], 'x-csrf-token': csrf.csrfToken,
  } }));
  return new Request('http://localhost:3000/api/wallet/strategy', { headers: { cookie: `${sessionCookieName()}=${own.sessionToken}` } });
}
async function settingsSnapshot() { return (await db.query('SELECT key,value,updated_at FROM app_settings ORDER BY key')).rows; }

beforeAll(async () => {
  await db.closeDatabase();
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL', ''); vi.stubEnv('VERCEL_ENV', '');
  vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://');
  vi.stubEnv('APP_ORIGIN', 'http://localhost:3000'); vi.stubEnv('MIRSAD_RETIRE_LEGACY_CONNECTION', undefined);
  vi.stubEnv('EXECUTION_SCHEDULER_TOKEN', executionToken); vi.stubEnv('DISCOVERY_SCHEDULER_TOKEN', discoveryToken);
  vi.stubEnv('INITIAL_PASSWORD_HASH', await hashPassword(password));
  await db.ensureSchema();
});
beforeEach(async () => {
  await db.query('TRUNCATE app_settings, app_sessions, app_owner, auth_rate_limits, audit_events, order_intents RESTART IDENTITY');
  installWalletExecutionSource(null);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network in isolated wallet setup test'); }));
});
afterEach(() => {
  try { expect(fetch).not.toHaveBeenCalled(); }
  finally { installWalletExecutionSource(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});
afterAll(async () => { await db.closeDatabase(); vi.unstubAllEnvs(); });

describe('owner-only wallet strategy configuration API', () => {
  it('rejects missing sessions, invalid cookies and both scheduler bearers before reading configuration', async () => {
    await put(activeKey, ['AAA-EUR']); await put(STRATEGY_PROFILE_KEY, envelope());
    const before = await settingsSnapshot(), spy = vi.spyOn(db, 'query');
    const credentials: Record<string, string>[] = [{}, { authorization: `Bearer ${executionToken}` },
      { authorization: `Bearer ${discoveryToken}` }, { cookie: `${sessionCookieName()}=${'x'.repeat(43)}` }];
    for (const headers of credentials) {
      const response = await GET(new Request('http://localhost:3000/api/wallet/strategy', { headers }));
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: 'authentication_required' });
    }
    expect(spy.mock.calls.some(([sql]) => /app_settings/i.test(sql))).toBe(false);
    expect(await settingsSnapshot()).toEqual(before); expect(walletExecutionSource()).toBeNull();
  });

  it('keeps missing owner configuration missing, returns no readiness claim and refreshes an uncached owner cookie', async () => {
    const request = await sessionRequest(), before = await settingsSnapshot();
    const response = await GET(request);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie'); expect(response.headers.get('set-cookie')).toContain(sessionCookieName());
    expect(await response.json()).toMatchObject({ accountId: CONFIG.accountId, strategyVersion: CONFIG.strategyVersion,
      sizing: { allocation: '0.10', reducedAllocation: '0.05', currency: 'EUR' },
      selectedMarkets: { status: 'missing', symbols: [] }, previousMarkets: { status: 'missing', symbols: [], purpose: 'historical-reference-only' },
      profile: { status: 'missing' }, unsupportedSelection: [], sourceInstallation: 'absent',
      executionReadiness: 'not-checked-by-this-endpoint', readinessPath: '/automation' });
    expect(await settingsSnapshot()).toEqual(before); expect(walletExecutionSource()).toBeNull();
  });

  it('keeps the previous account watchlist historical and never copies it into the active wallet selection', async () => {
    await put('watchlist', ['OLD-EUR', 'AAA-EUR']);
    const request = await sessionRequest(), before = await settingsSnapshot();
    const response = await GET(request);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({
      selectedMarkets: { status: 'missing', symbols: [] },
      previousMarkets: { status: 'valid', symbols: ['OLD-EUR', 'AAA-EUR'], purpose: 'historical-reference-only' }, profile: { status: 'missing' },
    });
    expect(await settingsSnapshot()).toEqual(before);
    expect((await db.query('SELECT key FROM app_settings WHERE key=$1', [activeKey])).rows).toEqual([]);
  });

  it('preserves an explicitly empty wallet selection even when profile mappings and historical selections exist', async () => {
    await put('watchlist', ['AAA-EUR']); await put(activeKey, []); await put(STRATEGY_PROFILE_KEY, envelope());
    const request = await sessionRequest(), before = await settingsSnapshot(), response = await GET(request);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({
      selectedMarkets: { status: 'valid', symbols: [] }, unsupportedSelection: [],
      profile: { status: 'configuration-only', authorityStatus: 'unverified' }, executionReadiness: 'not-checked-by-this-endpoint',
    });
    expect(await settingsSnapshot()).toEqual(before); expect(walletExecutionSource()).toBeNull();
  });

  it('returns the selected markets and safe profile summary while flagging unmapped selections without promoting authority', async () => {
    await put(activeKey, ['AAA-EUR', 'UNKNOWN-EUR', 'AAA-EUR']); await put(STRATEGY_PROFILE_KEY, envelope());
    await put('unrelated:private-setting', { internalMarker: 'isolated-setting-not-for-the-dto' });
    const response = await GET(await sessionRequest()), value = await response.json();
    expect(response.status).toBe(200); expect(value.selectedMarkets).toEqual({ status: 'valid', symbols: ['AAA-EUR', 'UNKNOWN-EUR'] });
    expect(value.unsupportedSelection).toEqual(['UNKNOWN-EUR']);
    expect(value.profile).toEqual({ status: 'configuration-only', revision: 3, authorityStatus: 'unverified', lifetimeStatus: 'within-window',
      chainId: 84532, owner: addr('1'), markets: ['AAA-EUR'], implementation: profile().implementation });
    expect(value.executionReadiness).toBe('not-checked-by-this-endpoint');
    const text = JSON.stringify(value);
    for (const excluded of ['grantReference', 'revocationReference', 'executor', 'quoteToken', 'scope', 'conversion', 'isolated-setting-not-for-the-dto']) {
      expect(text).not.toContain(excluded);
    }
    expect(walletExecutionSource()).toBeNull();
  });

  it('sanitizes a private internal database failure rather than returning its message or partial configuration', async () => {
    const request = await sessionRequest(), original = db.query, marker = 'isolated-private-database-failure';
    vi.spyOn(db, 'query').mockImplementation(async <T>(sql: string, params?: unknown[]) => {
      if (/FROM app_settings/i.test(sql)) throw new Error(`postgres://isolated-user:${marker}@example.invalid/private`);
      return original<T>(sql, params);
    });
    const response = await GET(request), value = await response.json();
    expect(response.status).toBe(503); expect(value).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(JSON.stringify(value)).not.toContain(marker); expect(JSON.stringify(value)).not.toContain('postgres://');
    expect(value).not.toHaveProperty('profile'); expect(value).not.toHaveProperty('selectedMarkets');
  });
});

describe('fail-closed configuration evidence without side effects', () => {
  it.each([null, { symbols: ['AAA-EUR'] }, ['AAA-EUR', 1], ['AAA-USD'], ['aaa-EUR'], Array(31).fill('AAA-EUR')].map(value => [value]))(
    'does not salvage or default malformed active selection %j', async bad => {
      await put(activeKey, bad); await put('watchlist', ['AAA-EUR']); await put(STRATEGY_PROFILE_KEY, envelope());
      const before = await settingsSnapshot(), value = await walletStrategySetup({ query: db.query }, NOW);
      expect(value.selectedMarkets).toEqual({ status: 'invalid', symbols: [] }); expect(value.unsupportedSelection).toEqual([]);
      expect(value.profile.status).toBe('configuration-only'); expect(value.executionReadiness).toBe('not-checked-by-this-endpoint');
      expect(await settingsSnapshot()).toEqual(before); expect(walletExecutionSource()).toBeNull();
    });

  it.each([null, { storageVersion: 2, revision: 1, profile: profile() },
    envelope({ status: 'connected', address: addr('1'), chainId: 84532 }),
    envelope({ ...profile(), authority: { ...profile().authority, verified: true, signature: 'isolated-untrusted-proof' } })])(
    'rejects corrupt or self-certified profile storage without exposing its contents: %j', async bad => {
      await put(STRATEGY_PROFILE_KEY, bad); await put(activeKey, ['AAA-EUR']);
      const request = await sessionRequest(), before = await settingsSnapshot(), response = await GET(request), value = await response.json();
      expect(response.status).toBe(200); expect(value.profile).toEqual({ status: 'invalid' });
      expect(value.unsupportedSelection).toEqual(['AAA-EUR']); expect(value.sourceInstallation).toBe('absent');
      expect(value.executionReadiness).toBe('not-checked-by-this-endpoint'); expect(JSON.stringify(value)).not.toContain('isolated-untrusted-proof');
      expect(await settingsSnapshot()).toEqual(before); expect(walletExecutionSource()).toBeNull();
    });

  it('treats malformed historical selection as invalid without changing a valid current selection', async () => {
    await put(activeKey, ['AAA-EUR']); await put('watchlist', { enabled: true, symbols: ['OLD-EUR'] });
    const before = await settingsSnapshot(), value = await walletStrategySetup({ query: db.query }, NOW);
    expect(value.selectedMarkets).toEqual({ status: 'valid', symbols: ['AAA-EUR'] });
    expect(value.previousMarkets).toEqual({ status: 'invalid', symbols: [], purpose: 'historical-reference-only' });
    expect(await settingsSnapshot()).toEqual(before);
  });

  it.each([['not-started', NOW + 60, NOW + 3600], ['expired', NOW - 3600, NOW]] as const)(
    'reports a %s profile lifetime without treating saved scope as verified authority', async (status, startsAt, expiresAt) => {
      const input = profile(); input.authority.startsAt = startsAt; input.authority.expiresAt = expiresAt;
      await put(STRATEGY_PROFILE_KEY, envelope(input));
      const value = await walletStrategySetup({ query: db.query }, NOW);
      expect(value.profile).toMatchObject({ status: 'configuration-only', authorityStatus: 'unverified', lifetimeStatus: status });
      expect(value.executionReadiness).toBe('not-checked-by-this-endpoint'); expect(walletExecutionSource()).toBeNull();
    });

  it('performs only SELECTs and leaves stored profiles, selections, runtime switches, order history and audit unchanged', async () => {
    await put(activeKey, ['AAA-EUR']); await put('watchlist', ['OLD-EUR']); await put(STRATEGY_PROFILE_KEY, envelope());
    await put(runtimeKey, { entriesEnabled: false, executionArmed: false, walletIdentity: 'isolated-existing-wallet' });
    await put('live_enabled', false); await put('wallet:trial:state', { enabled: false, state: null });
    await db.query(`INSERT INTO order_intents(id,idempotency_key,broker,account_id,instrument,request,state)
      VALUES('isolated-history','isolated-history-key','metamask',$1,'AAA-EUR','{}','filled')`, [CONFIG.accountId]);
    await db.query("INSERT INTO audit_events(event,detail) VALUES('isolated.history','{}')");
    const request = await sessionRequest(), before = await settingsSnapshot();
    const orders = (await db.query('SELECT * FROM order_intents ORDER BY id')).rows;
    const audit = (await db.query('SELECT * FROM audit_events ORDER BY id')).rows;
    const reads: string[] = [];
    const readOnly: db.SqlExecutor = { async query<T>(sql: string, params?: unknown[]) {
      reads.push(sql); if (!/^\s*SELECT\b/i.test(sql)) throw new Error('setup_must_be_read_only');
      return db.query<T>(sql, params);
    } };
    await walletStrategySetup(readOnly, NOW); await walletStrategySetup(readOnly, NOW + 1);
    expect((await GET(request)).status).toBe(200); expect(reads.length).toBeGreaterThan(0);
    expect(await settingsSnapshot()).toEqual(before);
    expect((await db.query('SELECT * FROM order_intents ORDER BY id')).rows).toEqual(orders);
    expect((await db.query('SELECT * FROM audit_events ORDER BY id')).rows).toEqual(audit);
    expect(walletExecutionSource()).toBeNull();
  });

  it('labels an existing source unverified without calling or replacing it', async () => {
    const probe = vi.fn(async () => { throw new Error('Configuration evidence must not invoke a source'); });
    const source: WalletVenueSource = { client: { getBalances: probe, getOrders: probe },
      instruments: probe, market: probe, candles: probe, verifyGrant: probe };
    installWalletExecutionSource(source);
    const value = await walletStrategySetup({ query: db.query }, NOW);
    expect(value.sourceInstallation).toBe('present-unverified'); expect(value.profile).toEqual({ status: 'missing' });
    expect(value.executionReadiness).toBe('not-checked-by-this-endpoint');
    expect(walletExecutionSource()).toBe(source); expect(probe).not.toHaveBeenCalled();
  });
});

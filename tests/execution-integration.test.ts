import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError } from '../src/lib/auth';
import { GET, POST } from '../src/app/api/execution/[...action]/route';
import { GET as legacyGet, POST as legacyPost } from '../src/app/api/education/[...action]/route';
import { executionReport } from '../src/lib/execution/service';
import { EDUCATION_STORAGE_KEY, readEducationAccount } from '../src/lib/execution/education-account';
import retiredWorker from '../automation/retired-scheduler.mjs';
import type { CancellationPort } from '../src/lib/execution/v1/deadline';
import { ConnectedRevolutVenue } from '../src/lib/execution/v1/revolut-venue';
import { account as fixtureAccount } from './execution-fixtures';
const auth = vi.hoisted(() => ({ requireSession: vi.fn(), requireMutation: vi.fn(), refreshSessionCookie: vi.fn() }));
const db = vi.hoisted(() => ({ query: vi.fn() }));
const host = vi.hoisted(() => ({ connectedVenue: vi.fn<() => Promise<CancellationPort | null>>(async () => null), runHost: vi.fn(), runTick: vi.fn(), runProtection: vi.fn(), entrySwitch: vi.fn(), handleDeadline: vi.fn(), refreshReadiness: vi.fn() }));
vi.mock('../src/lib/auth', async original => ({ ...(await original<typeof import('../src/lib/auth')>()), ...auth }));
vi.mock('../src/lib/db', async original => ({ ...(await original<typeof import('../src/lib/db')>()), ...db }));
vi.mock('../src/lib/execution/v1/host', () => host);
const storedAccount = () => ({ version: 1 as const, updatedAt: new Date().toISOString(), balances: [{ currency: 'EUR', total: '97.43', available: '87.43', reserved: '10' }], positions: [], orders: [] });
const context = (action: string) => ({ params: Promise.resolve({ action: [action] }) });
const request = (action: string, data: unknown = {}, token?: string) => new Request(`https://mirsad.test/api/execution/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data) });
beforeEach(() => {
  vi.clearAllMocks(); db.query.mockResolvedValue({ rows: [], rowCount: 0 });
  host.connectedVenue.mockResolvedValue(null);
  auth.requireSession.mockResolvedValue({ id: 'test-session', csrfToken: 'test-csrf-token' }); auth.requireMutation.mockResolvedValue({ id: 'test-session' }); auth.refreshSessionCookie.mockResolvedValue('test-session=renewed');
  host.refreshReadiness.mockResolvedValue({ status: 'checked' });
  host.runHost.mockResolvedValue({ status: 'blocked', reason: 'order_api_not_connected' });
  host.runTick.mockResolvedValue({ status: 'blocked', reason: 'order_api_not_connected' });
  host.runProtection.mockResolvedValue({ status: 'idle' });
  host.handleDeadline.mockResolvedValue({ status: 'cancelled' }); host.entrySwitch.mockResolvedValue({ entriesEnabled: false, orderApiConnected: false });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('scoped native account integration and authenticated endpoints', () => {
  it('does not seed balances or report an absent account as zero', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect(await executionReport()).toMatchObject({ version: '1.0.0', enabled: false, account_connected: false, available_eur: null, positions: null, orders: null, performance: null, signal_configured: true });
    expect(db.query.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true); expect(fetcher).not.toHaveBeenCalled();
  });
  it('authenticates reports, renews the session and prevents caching', async () => {
    const response = await GET(new Request('https://mirsad.test/api/execution/report'), context('report'));
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store'); expect(response.headers.get('set-cookie')).toBe('test-session=renewed');
    auth.requireSession.mockRejectedValueOnce(new AuthError(401, 'AUTH_REQUIRED', 'Session required'));
    expect((await GET(new Request('https://mirsad.test/api/execution/report'), context('report'))).status).toBe(401);
  });
  it('requires mutation auth and validates settings rather than injecting signals', async () => {
    auth.requireMutation.mockRejectedValueOnce(new AuthError(403, 'CSRF_REQUIRED', 'CSRF required'));
    expect((await POST(request('run'), context('run'))).status).toBe(403);
    expect((await POST(request('settings', { entriesEnabled: false }), context('settings'))).status).toBe(200);
    expect(host.entrySwitch).toHaveBeenCalledWith(false);
    host.entrySwitch.mockResolvedValueOnce({ status: 'blocked', reason: 'execution_capabilities_missing' });
    expect((await POST(request('settings', { entriesEnabled: true }), context('settings'))).status).toBe(409);
    expect((await POST(request('run', { signal: 'injected' }), context('run'))).status).toBe(400);
  });
  it('checks readiness through authenticated read-only source work without toggling execution or running a trading cycle', async () => {
    expect((await POST(request('check'), context('check'))).status).toBe(200);
    expect(host.refreshReadiness).toHaveBeenCalledOnce(); expect(host.entrySwitch).not.toHaveBeenCalled(); expect(host.runHost).not.toHaveBeenCalled();
    expect((await POST(request('check', { entriesEnabled: true }), context('check'))).status).toBe(400);
    auth.requireMutation.mockRejectedValueOnce(new AuthError(403, 'CSRF_REQUIRED', 'CSRF required'));
    expect((await POST(request('check'), context('check'))).status).toBe(403);
    const report = await GET(new Request('https://mirsad.test/api/execution/report'), context('report'));
    expect((await report.json()).csrfToken).toBe('test-csrf-token');
  });
  it.each(['production', 'preview', 'development'])('adds no platform classification gate for %s', async value => {
    vi.stubEnv('VERCEL_ENV', value);
    const response = await POST(request('run'), context('run'));
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ reason: 'order_api_not_connected' }); expect(host.runHost).toHaveBeenCalledOnce();
  });
  it('authenticates both the 5-minute scheduler and independent deadline callbacks', async () => {
    vi.stubEnv('EXECUTION_SCHEDULER_TOKEN', 'unit-test-secret');
    expect((await POST(request('tick'), context('tick'))).status).toBe(401);
    expect((await POST(request('tick', {}, 'wrong'), context('tick'))).status).toBe(401);
    expect((await POST(request('tick', {}, 'unit-test-secret'), context('tick'))).status).toBe(409);
    expect((await POST(request('deadline', { key: 'a'.repeat(64) }, 'unit-test-secret'), context('deadline'))).status).toBe(200);
    expect(host.handleDeadline).toHaveBeenCalledWith('a'.repeat(64));
    expect((await POST(request('protect'), context('protect'))).status).toBe(401);
    expect((await POST(request('protect', { key: 'injected' }, 'unit-test-secret'), context('protect'))).status).toBe(400);
    expect((await POST(request('protect', {}, 'unit-test-secret'), context('protect'))).status).toBe(200);
    expect(host.runProtection).toHaveBeenCalledOnce();
  });
  it.each(['tick', 'setup', 'settings', 'run'])('leaves retired %s requests inert', async action => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect((await legacyPost(request(action), context(action))).status).toBe(410); expect(fetcher).not.toHaveBeenCalled();
  });
  it('retires old report and worker without deleting account records', async () => {
    expect((await legacyGet(new Request('https://mirsad.test/api/education/report'))).status).toBe(410);
    expect(await retiredWorker.scheduled()).toEqual({ status: 'retired' }); expect((await retiredWorker.fetch()).status).toBe(410);
  });
  it('preserves exact stored balances, old levels and source timestamps without adopting holdings', async () => {
    const account = { ...storedAccount(), updatedAt: '2020-01-01T00:00:00Z', positions: [{ id: 'old', symbol: 'BTC-EUR', quantity: '0.02', entryPrice: '50000', stopPrice: '49000', targetPrice: '52000' }] };
    const original = structuredClone(account);
    db.query.mockImplementation(async (_sql, params) => ({ rows: params?.[0] === EDUCATION_STORAGE_KEY ? [{ value: account }] : [], rowCount: 1 }));
    expect(await readEducationAccount()).toMatchObject(account);
    // The owner selected the connected dashboard account. The legacy saved
    // record is preserved but must not masquerade as that connection.
    expect(await executionReport()).toMatchObject({ account_connected: false, available_eur: null, source_at: null, positions: null, execution_ready: false });
    expect(account).toEqual(original);
  });
  it('reports the selected existing account without equating connectivity with execution readiness', async () => {
    const balances = [{ accountId: 'revolut-x' as const, currency: 'EUR', total: '23.45', available: '20.12', reserved: '3.33', observedAt: new Date().toISOString() }];
    host.connectedVenue.mockResolvedValue(new ConnectedRevolutVenue({
      client: { getBalances: async () => balances, getOrders: async () => [] },
      instruments: async () => [], market: async () => { throw new Error('unused'); }, candles: async () => [],
    }));
    expect(await executionReport()).toMatchObject({ account_id: 'revolut-x', account_connected: true,
      adapter_configured: true, execution_ready: false, enabled: false, available_eur: '20.12',
      reason: 'execution_data_incomplete', status: 'monitoring', protection: { mode: 'mirsad', armed: false } });
    expect(db.query.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
    expect(db.query.mock.calls.some(([, params]) => params?.[0] === EDUCATION_STORAGE_KEY)).toBe(false);
  });
  it('propagates invalid balances and database failure instead of inventing data', async () => {
    const account = storedAccount(); account.balances[0].available = '100';
    db.query.mockResolvedValueOnce({ rows: [{ value: account }], rowCount: 1 }); await expect(readEducationAccount()).rejects.toThrow();
    db.query.mockRejectedValueOnce(new Error('database_unavailable'));
    expect((await GET(new Request('https://mirsad.test/api/execution/report'), context('report'))).status).toBe(503);
  });
  it('keeps stored monitoring visible when source validation fails, without changing execution or inventing balances', async () => {
    const heartbeat = { at: Math.floor(Date.now() / 1000), status: 'blocked', managedPositions: 1, errors: ['source_unavailable'] };
    const savedReport = { readAt: 100, sourceAt: 99, status: 'source_read' };
    db.query.mockImplementation(async (_sql, params) => ({ rows: params?.[0]?.endsWith(':state')
      ? [{ value: { entriesEnabled: true, executionArmed: true, lastSuccessfulReport: savedReport } }]
      : params?.[0]?.endsWith(':protection_heartbeat') ? [{ value: heartbeat }] : [], rowCount: 1 }));
    host.connectedVenue.mockResolvedValue(new ConnectedRevolutVenue({
      client: { getBalances: async () => { throw new Error('source_balance_mismatch'); }, getOrders: async () => [] },
      instruments: async () => [], market: async () => { throw new Error('unused'); }, candles: async () => [],
    }));
    const response = await GET(new Request('https://mirsad.test/api/execution/report'), context('report'));
    expect(response.status).toBe(200);
    const report = await response.json();
    expect(report).toMatchObject({ report_status: 'partial', account_connected: false, execution_ready: false,
      enabled: false, entries_requested: true, balances: null, available_eur: null, closed_trades: null, performance: null,
      protection: { armed: true, heartbeat }, last_successful_report: savedReport,
      read_errors: [{ stage: 'account', code: 'source_balance_mismatch' }, { stage: 'account_details', code: 'source_balance_mismatch' }] });
    expect(report.blockers).toContain('source_balance_mismatch');
    expect(db.query.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
    expect(host.runHost).not.toHaveBeenCalled(); expect(host.runProtection).not.toHaveBeenCalled();
    expect(host.entrySwitch).not.toHaveBeenCalled(); expect(host.refreshReadiness).not.toHaveBeenCalled();
  });
  it('redacts arbitrary provider error text and can recover on the next report read', async () => {
    host.connectedVenue.mockRejectedValueOnce(new Error('secret-provider-token https://private.example'));
    const failed = await executionReport();
    expect(failed.read_errors).toMatchObject([{ stage: 'connection', code: 'report_connection_unavailable' }]);
    expect(JSON.stringify(failed)).not.toContain('secret-provider-token');
    const recovered = await executionReport();
    expect(recovered.read_errors).toEqual([]);
    expect(recovered.report_status).toBe('current');
  });
  it('keeps the execution failure visible when diagnostic order details recover the report', async () => {
    const venue = new ConnectedRevolutVenue({ client: { getBalances: async () => [], getOrders: async () => [] },
      instruments: async () => [], market: async () => { throw new Error('unused'); }, candles: async () => [] });
    vi.spyOn(venue, 'account').mockRejectedValueOnce(new Error('managed_exit_fill_mismatch'))
      .mockResolvedValueOnce({ ...fixtureAccount(), id: 'revolut-x' });
    host.connectedVenue.mockResolvedValue(venue);
    const report = await executionReport();
    expect(report).toMatchObject({ account_connected: true, account_read_method: 'source_order_details_for_reporting',
      report_status: 'partial', execution_ready: false, enabled: false,
      read_errors: [{ stage: 'account', code: 'managed_exit_fill_mismatch' }] });
    expect(report.balances).not.toBeNull(); expect(report.performance).not.toBeNull();
    expect(report.blockers).toContain('managed_exit_fill_mismatch');
    expect(host.runHost).not.toHaveBeenCalled(); expect(host.entrySwitch).not.toHaveBeenCalled();
  });
  it('exposes incomplete performance coverage for documentation without labelling it zero profit', async () => {
    host.connectedVenue.mockResolvedValue(new ConnectedRevolutVenue({
      client: { getBalances: async () => [{ accountId: 'revolut-x', currency: 'EUR', total: '10', available: '10', reserved: '0', observedAt: new Date().toISOString() }], getOrders: async () => [] },
      instruments: async () => [], market: async () => { throw new Error('unused'); }, candles: async () => [],
    }));
    const report = await executionReport();
    expect(report).toMatchObject({ closed_trades: [], fills: [], trade_history_complete: false,
      performance: { last24h: { coverageComplete: false, confirmedClosedTrades: 0, realizedNetPnlEur: null, wins: null, winRate: null },
        berlinToday: { coverageComplete: false, realizedNetPnlEur: null } } });
  });
  it('runs current fill verification even when the engine account is readable and retains both sets of blockers', async () => {
    const venue = new ConnectedRevolutVenue({ client: { getBalances: async () => [], getOrders: async () => [] },
      instruments: async () => [], market: async () => { throw new Error('unused'); }, candles: async () => [] });
    vi.spyOn(venue, 'account').mockResolvedValue({ ...fixtureAccount(), dataBlockers: ['accounting_evidence_stale'] });
    const audit = vi.spyOn(venue, 'reportAccount').mockResolvedValue({ ...fixtureAccount(), tradeHistoryComplete: false,
      reportEvidence: { readAt: 1, status: 'conflict', issues: ['report_fill_price_mismatch'], orders: [] },
      dataBlockers: ['report_fill_price_mismatch'] });
    host.connectedVenue.mockResolvedValue(venue);
    const report = await executionReport();
    expect(audit).toHaveBeenCalledOnce();
    expect(report).toMatchObject({ report_status: 'partial', execution_ready: false,
      source_reconciliation: { status: 'conflict' } });
    expect(report.blockers).toEqual(expect.arrayContaining(['accounting_evidence_stale', 'report_fill_price_mismatch']));
  });
});


import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/lib/db', () => storage);
vi.mock('../src/lib/execution/v1/host', () => ({ connectedVenue: vi.fn(), runHost: vi.fn() }));
vi.mock('../src/lib/wallet/selection-service', () => ({ strategyEntrySelection: vi.fn() }));
import { connectedVenue, runHost } from '../src/lib/execution/v1/host';
import { executionReport } from '../src/lib/execution/service';
import { strategyEntrySelection } from '../src/lib/wallet/selection-service';
import { CONFIG } from '../src/lib/execution/v1/model';
import { account, NOW } from './execution-fixtures';

function healthyVenue() {
  const fake = { account: vi.fn(async () => account()), reportAccount: vi.fn(async () => account()),
    capabilities: vi.fn(async () => ({ idempotentOrders: true, fencedWrites: true, attachedProtection: false, managedProtection: true,
      coordinatedExits: true, cancelRemainder: true, cancellationTimer: true, entryRiskData: true })),
    submit: vi.fn(), cancelRemainder: vi.fn(), armCancellation: vi.fn(), ensureProtection: vi.fn(), refreshAccounting: vi.fn() };
  vi.mocked(connectedVenue).mockResolvedValue(fake as unknown as Awaited<ReturnType<typeof connectedVenue>>);
  return fake;
}
beforeEach(() => {
  vi.clearAllMocks(); storage.query.mockResolvedValue({ rows: [], rowCount: 0 });
  vi.useFakeTimers(); vi.setSystemTime(NOW * 1000); vi.stubEnv('MIRSAD_ORDER_CONNECTION', 'metamask');
  vi.mocked(strategyEntrySelection).mockResolvedValue({ mode: 'opportunities', revision: 1, symbols: ['AAA-EUR', 'BBB-EUR'], reason: null });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Report aggregation must not initiate network calls'); }));
});
afterEach(() => {
  try { expect(fetch).not.toHaveBeenCalled(); expect(runHost).not.toHaveBeenCalled(); }
  finally { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});
describe('owner report shares wallet financial readiness checks', () => {
  it('reports healthy verified opportunities as ready while entries remain unrequested and no financial action runs', async () => {
    const venue = healthyVenue(), report = await executionReport();
    expect(report).toMatchObject({ adapter_configured: true, account_connected: true, execution_ready: true,
      enabled: false, entries_requested: false, status: 'entries_paused', report_status: 'current',
      market_selection: { mode: 'opportunities', revision: 1, symbols: ['AAA-EUR', 'BBB-EUR'] } });
    expect(report.blockers).toEqual([]); expect(report.read_errors).toEqual([]);
    expect(report.available_eur).toBe('1000'); expect(report.accounting.valuation_complete).toBe(true);
    expect(venue.account).toHaveBeenCalledOnce(); expect(venue.reportAccount).toHaveBeenCalledOnce();
    expect(venue.capabilities).toHaveBeenCalledOnce(); expect(strategyEntrySelection).toHaveBeenCalledOnce();
    for (const action of [venue.submit, venue.cancelRemainder, venue.armCancellation, venue.ensureProtection, venue.refreshAccounting]) {
      expect(action).not.toHaveBeenCalled();
    }
    expect(storage.query.mock.calls.every(([sql]) => /^SELECT\b/i.test(sql))).toBe(true);
  });
  it.each([
    { mode: 'opportunities' as const, revision: 1, symbols: [], reason: 'wallet_opportunity_universe_unavailable' },
    { mode: 'invalid' as const, revision: null, symbols: [], reason: 'wallet_strategy_selection_invalid' },
    { mode: 'manual' as const, revision: null, symbols: [], reason: 'configured_symbols_missing' },
  ])('blocks report readiness for $mode selection with $reason despite otherwise healthy account and capabilities', async selection => {
    const venue = healthyVenue(); vi.mocked(strategyEntrySelection).mockResolvedValue(selection);
    const report = await executionReport();
    expect(report).toMatchObject({ adapter_configured: true, account_connected: true, execution_ready: false,
      enabled: false, entries_requested: false, report_status: 'current',
      market_selection: { mode: selection.mode, revision: selection.revision, symbols: [] } });
    expect(report.blockers).toEqual([selection.reason]); expect(report.read_errors).toEqual([]);
    expect(report.accounting.valuation_complete).toBe(true); expect(report.balances).toEqual(account().balances);
    expect(venue.submit).not.toHaveBeenCalled(); expect(venue.cancelRemainder).not.toHaveBeenCalled();
  });
  it('preserves stored protection and report history independently of blocked selection and secret-bearing provider failures', async () => {
    const secret = 'https://rpc.invalid/?apiKey=isolated-report-secret', venue = healthyVenue();
    venue.account.mockRejectedValue(new Error(secret)); venue.reportAccount.mockRejectedValue(new Error(secret));
    venue.capabilities.mockRejectedValue(new Error(secret));
    vi.mocked(strategyEntrySelection).mockResolvedValue({ mode: 'opportunities', revision: 2, symbols: [], reason: 'wallet_opportunity_universe_unavailable' });
    const heartbeat = { at: NOW, status: 'watching', managedPositions: 1, checkedPositions: 1, errors: [] };
    const lastCycle = { type: 'cycle', id: 'isolated-last-cycle', status: 'waiting' };
    const lastReport = { id: 'isolated-last-successful-report', status: 'source_read', readAt: NOW - 60 };
    const protection = { entryKey: 'isolated-protection-entry', symbol: 'AAA-EUR', status: 'watching' };
    storage.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const key = params[0];
      const rows = sql.includes('FROM audit_events') ? [{ detail: lastCycle }]
        : key === `execution:v1:${CONFIG.accountId}:state` ? [{ value: { entriesEnabled: false, executionArmed: true,
          risk: { reduced: false, dailyHaltDate: null }, indicators: {}, lastSuccessfulReport: lastReport } }]
        : key === `execution:v1:${CONFIG.accountId}:protection_heartbeat` ? [{ value: heartbeat }]
        : key === `execution:v1:${CONFIG.accountId}:protection:%` ? [{ value: protection }] : [];
      return { rows, rowCount: rows.length };
    });
    const report = await executionReport();
    expect(report).toMatchObject({ execution_ready: false, entries_requested: false, report_status: 'partial',
      protection: { armed: true, heartbeat, heartbeat_fresh: true, records: [protection], continues_when_entries_paused: true },
      last_cycle: lastCycle, last_successful_report: lastReport });
    expect(report.blockers).toContain('wallet_opportunity_universe_unavailable');
    expect(report.read_errors).toEqual([
      { stage: 'account', code: 'report_account_unavailable', at: NOW },
      { stage: 'account_details', code: 'report_account_details_unavailable', at: NOW },
      { stage: 'capabilities', code: 'report_capabilities_unavailable', at: NOW },
    ]);
    expect(JSON.stringify(report)).not.toContain(secret); expect(JSON.stringify(report)).not.toContain('isolated-report-secret');
    expect(venue.submit).not.toHaveBeenCalled(); expect(venue.ensureProtection).not.toHaveBeenCalled();
    expect(storage.query.mock.calls.every(([sql]) => /^SELECT\b/i.test(sql))).toBe(true);
  });
  it('reports the missing strategy transport before a wallet account is connected', async () => {
    vi.stubEnv('MIRSAD_ORDER_CONNECTION', 'metamask');
    vi.mocked(connectedVenue).mockResolvedValue(null);
    const report = await executionReport();
    expect(report.adapter_configured).toBe(false);
    expect(report.account_connected).toBe(false);
    expect(report.blockers).toContain('wallet_execution_not_configured');
    expect(report.execution_ready).toBe(false);
    expect(report.enabled).toBe(false);
    expect(report.balances).toBeNull();
  });
  it.each(['valuation', 'stale', 'secret'])('does not announce readiness for a %s snapshot even if transport methods exist', async kind => {
    vi.useFakeTimers(); vi.setSystemTime(NOW * 1000); vi.stubEnv('MIRSAD_ORDER_CONNECTION', 'metamask');
    const snapshot = account();
    if (kind === 'valuation') snapshot.valuationComplete = false;
    if (kind === 'stale') snapshot.sourceAt = NOW - 31;
    if (kind === 'secret') snapshot.dataBlockers = ['https://rpc.invalid/?key=fixture-secret'];
    const fake = { account: async () => snapshot, reportAccount: async () => snapshot,
      capabilities: async () => ({ idempotentOrders: true, fencedWrites: true, attachedProtection: false, managedProtection: true,
        coordinatedExits: true, cancelRemainder: true, cancellationTimer: true, entryRiskData: true }) };
    vi.mocked(connectedVenue).mockResolvedValue(fake as Awaited<ReturnType<typeof connectedVenue>>);
    const report = await executionReport();
    expect(report.execution_ready).toBe(false); expect(report.enabled).toBe(false);
    expect(report.blockers).toContain(kind === 'valuation' ? 'account_valuation_missing' : kind === 'stale' ? 'account_stale' : 'wallet_account_data_incomplete');
    expect(JSON.stringify(report)).not.toContain('fixture-secret');
  });
});

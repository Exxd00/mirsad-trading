import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/lib/db', () => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }));
vi.mock('../src/lib/execution/v1/host', () => ({ connectedVenue: vi.fn(), runHost: vi.fn() }));
import { connectedVenue } from '../src/lib/execution/v1/host';
import { executionReport } from '../src/lib/execution/service';
import { account, NOW } from './execution-fixtures';

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('owner report shares wallet financial readiness checks', () => {
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

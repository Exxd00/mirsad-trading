import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('../src/lib/db', () => storage);
vi.mock('../src/lib/execution/v1/runner', async original => ({
  ...await original<typeof import('../src/lib/execution/v1/runner')>(), cycle: vi.fn(),
}));
vi.mock('../src/lib/execution/v1/reporting', async original => ({
  ...await original<typeof import('../src/lib/execution/v1/reporting')>(), dailyReport: vi.fn(),
}));
vi.mock('../src/lib/wallet/execution-connection', async original => ({
  ...await original<typeof import('../src/lib/wallet/execution-connection')>(), walletExecutionSource: vi.fn(),
}));
vi.mock('../src/lib/wallet/selection-service', () => ({ strategyEntrySelection: vi.fn() }));

import { journal, runTick } from '../src/lib/execution/v1/host';
import { cycle } from '../src/lib/execution/v1/runner';
import { dailyReport } from '../src/lib/execution/v1/reporting';
import { ConnectedWalletVenue, type WalletVenueSource } from '../src/lib/execution/v1/wallet-venue';
import { walletExecutionSource } from '../src/lib/wallet/execution-connection';
import { strategyEntrySelection } from '../src/lib/wallet/selection-service';
import { NOW, order, testWalletSource } from './execution-fixtures';

// Only the cycle/report bodies are isolated here. The real runTick, runHost and
// connectedVenue control flow must preserve stage independence without retries.
const completed = () => ({ id: 'isolated-completed-cycle', at: NOW, status: 'submitted', blocks: [], sourceOrder: order() });
const report = { id: 'isolated-daily-report', status: 'source_read' };
const secret = 'https://rpc.invalid/?apiKey=isolated-tick-private-marker';
let source: WalletVenueSource;
let actions: ReturnType<typeof vi.fn>[];

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW * 1000); vi.stubEnv('MIRSAD_ORDER_CONNECTION', 'metamask');
  storage.query.mockReset().mockImplementation(async () => { throw new Error('Tick aggregation must not access database storage'); });
  storage.transaction.mockReset().mockImplementation(async () => { throw new Error('Tick aggregation must not mutate database storage'); });
  const getBalances = vi.fn(async () => []), getOrders = vi.fn(async () => []), submitOrder = vi.fn(), cancelOrder = vi.fn();
  source = { ...testWalletSource(), client: { getBalances, getOrders, submitOrder, cancelOrder },
    instruments: vi.fn(async () => []), market: vi.fn(), candles: vi.fn(async () => []) };
  actions = [getBalances, getOrders, submitOrder, cancelOrder];
  vi.mocked(walletExecutionSource).mockReset().mockReturnValue(source);
  vi.mocked(strategyEntrySelection).mockReset().mockResolvedValue({ mode: 'opportunities', revision: 1, symbols: ['AAA-EUR'], reason: null });
  vi.mocked(cycle).mockReset().mockResolvedValue(completed());
  vi.mocked(dailyReport).mockReset().mockResolvedValue(report);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network in isolated tick continuity tests'); }));
});
afterEach(() => {
  try {
    expect(storage.query).not.toHaveBeenCalled(); expect(storage.transaction).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    for (const action of actions) expect(action).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe('real host tick preserves execution and reporting independence', () => {
  it('runs one execution cycle and one separately constructed report venue in order', async () => {
    expect(await runTick()).toEqual({ ...completed(), report });
    expect(cycle).toHaveBeenCalledExactlyOnceWith(expect.any(ConnectedWalletVenue), journal, ['AAA-EUR']);
    expect(dailyReport).toHaveBeenCalledExactlyOnceWith(expect.any(ConnectedWalletVenue), journal, NOW);
    // Execution constructs its venue and checks source presence for selection;
    // reporting then constructs its own venue independently.
    expect(walletExecutionSource).toHaveBeenCalledTimes(3);
    expect(vi.mocked(cycle).mock.calls[0][0]).not.toBe(vi.mocked(dailyReport).mock.calls[0][0]);
    expect(vi.mocked(cycle).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(dailyReport).mock.invocationCallOrder[0]);
  });

  it('still attempts the daily report once after an execution exception and sanitizes the failed execution result', async () => {
    vi.mocked(cycle).mockRejectedValueOnce(new Error(secret));
    const result = await runTick();
    expect(result).toEqual({ status: 'blocked', reason: 'cycle_failed', report });
    expect(JSON.stringify(result)).not.toContain('isolated-tick-private-marker');
    expect(cycle).toHaveBeenCalledOnce(); expect(dailyReport).toHaveBeenCalledOnce();
    expect(walletExecutionSource).toHaveBeenCalledTimes(3);
  });

  it('returns two sanitized blocked stages when execution and report both throw without retrying either', async () => {
    vi.mocked(cycle).mockRejectedValueOnce(new Error(secret)); vi.mocked(dailyReport).mockRejectedValueOnce(new Error(secret));
    const result = await runTick();
    expect(result).toEqual({ status: 'blocked', reason: 'cycle_failed', report: { status: 'blocked', reason: 'report_source_unavailable' } });
    expect(JSON.stringify(result)).not.toContain(secret); expect(cycle).toHaveBeenCalledOnce(); expect(dailyReport).toHaveBeenCalledOnce();
  });

  it('retains known local error codes for each failed stage', async () => {
    vi.mocked(cycle).mockRejectedValueOnce(new Error('wallet_grant_unverified'));
    vi.mocked(dailyReport).mockRejectedValueOnce(new Error('report_source_missing_or_stale'));
    expect(await runTick()).toEqual({ status: 'blocked', reason: 'wallet_grant_unverified',
      report: { status: 'blocked', reason: 'report_source_missing_or_stale' } });
    expect(cycle).toHaveBeenCalledOnce(); expect(dailyReport).toHaveBeenCalledOnce();
  });

  it('preserves the completed execution result when daily reporting fails and never repeats a submitted cycle', async () => {
    vi.mocked(dailyReport).mockRejectedValueOnce(new Error(secret));
    const result = await runTick();
    expect(result).toEqual({ ...completed(), report: { status: 'blocked', reason: 'report_source_unavailable' } });
    expect(result.status).toBe('submitted'); expect(result).toHaveProperty('sourceOrder', completed().sourceOrder);
    expect(JSON.stringify(result)).not.toContain(secret); expect(cycle).toHaveBeenCalledOnce(); expect(dailyReport).toHaveBeenCalledOnce();
  });

  it('isolates a failure constructing the report venue after execution succeeds', async () => {
    vi.mocked(walletExecutionSource).mockReturnValueOnce(source).mockReturnValueOnce(source)
      .mockImplementationOnce(() => { throw new Error(secret); });
    expect(await runTick()).toEqual({ ...completed(), report: { status: 'blocked', reason: 'report_source_unavailable' } });
    expect(cycle).toHaveBeenCalledOnce(); expect(dailyReport).not.toHaveBeenCalled(); expect(walletExecutionSource).toHaveBeenCalledTimes(3);
  });

  it('attempts a fresh report venue after the execution venue factory fails without retrying execution', async () => {
    vi.mocked(walletExecutionSource).mockImplementationOnce(() => { throw new Error(secret); }).mockReturnValueOnce(source);
    const result = await runTick();
    expect(result).toEqual({ status: 'blocked', reason: 'cycle_failed', report });
    expect(JSON.stringify(result)).not.toContain(secret); expect(cycle).not.toHaveBeenCalled();
    expect(dailyReport).toHaveBeenCalledExactlyOnceWith(expect.any(ConnectedWalletVenue), journal, NOW);
    expect(walletExecutionSource).toHaveBeenCalledTimes(2);
  });

  it('still invokes daily reporting with null when no strategy execution source is installed', async () => {
    vi.mocked(walletExecutionSource).mockReturnValue(null);
    vi.mocked(dailyReport).mockResolvedValueOnce({ status: 'blocked', reason: 'order_api_not_connected' });
    const result = await runTick();
    expect(result).toMatchObject({ status: 'blocked', reason: 'wallet_execution_transport_missing',
      report: { status: 'blocked', reason: 'order_api_not_connected' } });
    expect(cycle).not.toHaveBeenCalled(); expect(strategyEntrySelection).not.toHaveBeenCalled();
    expect(dailyReport).toHaveBeenCalledExactlyOnceWith(null, journal, NOW); expect(walletExecutionSource).toHaveBeenCalledTimes(2);
  });
});

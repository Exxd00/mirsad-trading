import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));
const observation = vi.hoisted(() => ({ runMarketObservation: vi.fn() }));
const preflight = vi.hoisted(() => ({ loadStrategyProfile: vi.fn(), loadAuthority: vi.fn(), resumeGnosisMarketReadiness: vi.fn() }));
vi.mock('../src/lib/db', () => storage);
vi.mock('../src/lib/execution/v1/market-observation', () => observation);
vi.mock('../src/lib/wallet/strategy-profile', () => ({ loadStrategyProfile: preflight.loadStrategyProfile }));
vi.mock('../src/lib/wallet/authority-store', () => ({ loadAuthority: preflight.loadAuthority }));
vi.mock('../src/lib/wallet/gnosis-market-readiness-job', () => ({ resumeGnosisMarketReadiness: preflight.resumeGnosisMarketReadiness }));
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

import { journal, runProtection, runTick } from '../src/lib/execution/v1/host';
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
const measurement = { status: 'updated', report: { mode: 'market-reference-only', marker: 'isolated-measurement' } };
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
  observation.runMarketObservation.mockReset().mockResolvedValue(measurement);
  preflight.loadStrategyProfile.mockReset().mockResolvedValue({ revision: 1, profile: { chainId: 100, owner: '0x' + '1'.repeat(40) } });
  preflight.loadAuthority.mockReset().mockResolvedValue({ state: 'verified', review: {
    chainId: 100, owner: '0x' + '1'.repeat(40), profileRevision: 1 } });
  preflight.resumeGnosisMarketReadiness.mockReset().mockResolvedValue({ job: null, report: null, currentFresh: false, reportFresh: false });
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
    expect(await runTick()).toEqual({ ...completed(), report, measurement });
    expect(observation.runMarketObservation).toHaveBeenCalledExactlyOnceWith({ trigger: 'scheduler' });
    expect(preflight.resumeGnosisMarketReadiness).not.toHaveBeenCalled();
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
    expect(result).toEqual({ status: 'blocked', reason: 'cycle_failed', report, measurement });
    expect(JSON.stringify(result)).not.toContain('isolated-tick-private-marker');
    expect(cycle).toHaveBeenCalledOnce(); expect(dailyReport).toHaveBeenCalledOnce();
    expect(walletExecutionSource).toHaveBeenCalledTimes(3);
  });

  it('returns two sanitized blocked stages when execution and report both throw without retrying either', async () => {
    vi.mocked(cycle).mockRejectedValueOnce(new Error(secret)); vi.mocked(dailyReport).mockRejectedValueOnce(new Error(secret));
    const result = await runTick();
    expect(result).toEqual({ status: 'blocked', reason: 'cycle_failed', report: { status: 'blocked', reason: 'report_source_unavailable' }, measurement });
    expect(JSON.stringify(result)).not.toContain(secret); expect(cycle).toHaveBeenCalledOnce(); expect(dailyReport).toHaveBeenCalledOnce();
  });

  it('retains known local error codes for each failed stage', async () => {
    vi.mocked(cycle).mockRejectedValueOnce(new Error('wallet_grant_unverified'));
    vi.mocked(dailyReport).mockRejectedValueOnce(new Error('report_source_missing_or_stale'));
    expect(await runTick()).toEqual({ status: 'blocked', reason: 'wallet_grant_unverified',
      report: { status: 'blocked', reason: 'report_source_missing_or_stale' }, measurement });
    expect(cycle).toHaveBeenCalledOnce(); expect(dailyReport).toHaveBeenCalledOnce();
  });

  it('preserves the completed execution result when daily reporting fails and never repeats a submitted cycle', async () => {
    vi.mocked(dailyReport).mockRejectedValueOnce(new Error(secret));
    const result = await runTick();
    expect(result).toEqual({ ...completed(), report: { status: 'blocked', reason: 'report_source_unavailable' }, measurement });
    expect(result.status).toBe('submitted'); expect(result).toHaveProperty('sourceOrder', completed().sourceOrder);
    expect(JSON.stringify(result)).not.toContain(secret); expect(cycle).toHaveBeenCalledOnce(); expect(dailyReport).toHaveBeenCalledOnce();
  });

  it('isolates a failure constructing the report venue after execution succeeds', async () => {
    vi.mocked(walletExecutionSource).mockReturnValueOnce(source).mockReturnValueOnce(source)
      .mockImplementationOnce(() => { throw new Error(secret); });
    expect(await runTick()).toEqual({ ...completed(), report: { status: 'blocked', reason: 'report_source_unavailable' }, measurement });
    expect(cycle).toHaveBeenCalledOnce(); expect(dailyReport).not.toHaveBeenCalled(); expect(walletExecutionSource).toHaveBeenCalledTimes(3);
  });

  it('attempts a fresh report venue after the execution venue factory fails without retrying execution', async () => {
    vi.mocked(walletExecutionSource).mockImplementationOnce(() => { throw new Error(secret); }).mockReturnValueOnce(source);
    const result = await runTick();
    expect(result).toEqual({ status: 'blocked', reason: 'cycle_failed', report, measurement });
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
    expect(result.measurement).toEqual(measurement); expect(observation.runMarketObservation).toHaveBeenCalledOnce();
  });
  it('keeps a submitted execution and daily report unchanged when independent measurement fails', async () => {
    observation.runMarketObservation.mockRejectedValueOnce(new Error(secret));
    const result = await runTick();
    expect(result).toEqual({ ...completed(), report, measurement: { status: 'unavailable', reason: 'market_observation_unavailable' } });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(cycle).toHaveBeenCalledOnce(); expect(dailyReport).toHaveBeenCalledOnce(); expect(observation.runMarketObservation).toHaveBeenCalledOnce();
  });
  it('finishes measurement even when both financial stages fail', async () => {
    vi.mocked(cycle).mockRejectedValueOnce(new Error(secret)); vi.mocked(dailyReport).mockRejectedValueOnce(new Error(secret));
    const result = await runTick();
    expect(result.measurement).toEqual(measurement);
    expect(observation.runMarketObservation).toHaveBeenCalledOnce(); expect(cycle).toHaveBeenCalledOnce(); expect(dailyReport).toHaveBeenCalledOnce();
  });
  it('awaits the existing owner-enabled preflight without a financial profile or source, without creating either', async () => {
    preflight.loadStrategyProfile.mockResolvedValue(null); vi.mocked(walletExecutionSource).mockReturnValue(null);
    let finish!: (value: { job: null; report: null; currentFresh: false; reportFresh: false }) => void;
    preflight.resumeGnosisMarketReadiness.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    let done = false; const pending = runTick().then(value => { done = true; return value; });
    await vi.waitFor(() => expect(preflight.resumeGnosisMarketReadiness).toHaveBeenCalledOnce());
    expect(done).toBe(false);
    const evidence = { job: null, report: null, currentFresh: false as const, reportFresh: false as const };
    finish(evidence);
    expect(await pending).toMatchObject({ status: 'blocked', reason: 'wallet_execution_transport_missing', marketReadiness: evidence, measurement });
    expect(cycle).not.toHaveBeenCalled(); expect(strategyEntrySelection).not.toHaveBeenCalled();
    expect(preflight.loadStrategyProfile).toHaveBeenCalledOnce();
  });
  it.each([null, 'draft', 'owner-actions-pending', 'signature-pending'])('keeps the existing data job independent of a %s Gnosis setup candidate', async state => {
    preflight.loadAuthority.mockResolvedValue(state === null ? null : { state });
    vi.mocked(walletExecutionSource).mockReturnValue(null);
    const evidence = { job: { state: 'waiting', attempts: 53 }, report: { referenceOnly: true } };
    preflight.resumeGnosisMarketReadiness.mockResolvedValue(evidence);
    expect(await runTick()).toMatchObject({ status: 'blocked', reason: 'wallet_execution_transport_missing', marketReadiness: evidence });
    expect(preflight.resumeGnosisMarketReadiness).toHaveBeenCalledOnce();
    expect(cycle).not.toHaveBeenCalled(); expect(strategyEntrySelection).not.toHaveBeenCalled();
  });
  it.each(['owner', 'chainId', 'profileRevision'])('does not let a verified grant for another %s stop the current profile data job', async field => {
    const review = { chainId: 100, owner: '0x' + '1'.repeat(40), profileRevision: 1,
      [field]: field === 'owner' ? '0x' + '2'.repeat(40) : field === 'chainId' ? 1 : 2 };
    preflight.loadAuthority.mockResolvedValue({ state: 'verified', review });
    vi.mocked(walletExecutionSource).mockReturnValue(null);
    expect(await runTick()).toHaveProperty('marketReadiness');
    expect(preflight.resumeGnosisMarketReadiness).toHaveBeenCalledOnce(); expect(cycle).not.toHaveBeenCalled();
  });
  it('leaves an Ethereum profile outside the owner-enabled Gnosis data job', async () => {
    preflight.loadStrategyProfile.mockResolvedValue({ profile: { chainId: 1 } });
    await runTick();
    expect(preflight.loadAuthority).not.toHaveBeenCalled(); expect(preflight.resumeGnosisMarketReadiness).not.toHaveBeenCalled();
  });
  it.each(['profile', 'authority', 'job'])('isolates and sanitizes a %s preflight failure without retrying financial work', async stage => {
    if (stage !== 'authority') preflight.loadStrategyProfile.mockResolvedValue(null);
    if (stage === 'profile') preflight.loadStrategyProfile.mockRejectedValueOnce(new Error(secret));
    else if (stage === 'authority') preflight.loadAuthority.mockRejectedValueOnce(new Error(secret));
    else preflight.resumeGnosisMarketReadiness.mockRejectedValueOnce(new Error(secret));
    const result = await runTick();
    expect(result).toEqual({ ...completed(), report, measurement,
      marketReadiness: { status: 'unavailable', reason: 'wallet_market_readiness_unavailable' } });
    expect(JSON.stringify(result)).not.toContain(secret); expect(cycle).toHaveBeenCalledOnce(); expect(dailyReport).toHaveBeenCalledOnce();
    expect(preflight.resumeGnosisMarketReadiness).toHaveBeenCalledTimes(stage === 'job' ? 1 : 0);
  });
  it('never runs market preflight from the 10-second protection host', async () => {
    vi.mocked(walletExecutionSource).mockReturnValue(null); preflight.loadStrategyProfile.mockResolvedValue(null);
    expect(await runProtection()).toMatchObject({ status: 'blocked', reason: 'wallet_execution_transport_missing' });
    expect(preflight.loadStrategyProfile).not.toHaveBeenCalled(); expect(preflight.resumeGnosisMarketReadiness).not.toHaveBeenCalled();
    expect(preflight.loadAuthority).not.toHaveBeenCalled();
    expect(observation.runMarketObservation).not.toHaveBeenCalled(); expect(cycle).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../src/lib/execution/v1/model';
import { connectedVenue, configuredSymbols, entrySwitch, handleDeadline, journal as hostJournal, refreshReadiness, runHost, runProtection } from '../src/lib/execution/v1/host';
import { ConnectedWalletVenue } from '../src/lib/execution/v1/wallet-venue';
import { installWalletExecutionSource, walletBindingIdentity, walletBindingIssue } from '../src/lib/wallet/execution-connection';
import { account, testWalletBinding, testWalletSource, NOW } from './execution-fixtures';
import { initialState, type Journal } from '../src/lib/execution/v1/journal';
import { accountEntryBlockers } from '../src/lib/execution/v1/readiness';
import { cycle, type VenuePort } from '../src/lib/execution/v1/runner';
import { trialEnabled } from '../src/lib/wallet/trial-service';

afterEach(() => { installWalletExecutionSource(null); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('unchanged Mirsad sheet rules on a wallet-only host', () => {
  it('retains the approved EMA strategy and all numeric trading limits', () => {
    expect(CONFIG).toMatchObject({ strategyVersion: 'mirsad-ema-15m-v1.0.0',
      timeframeSeconds: 900, warmupCandles: 1000, scanSeconds: 300, signalTtlSeconds: 300,
      maxEntryChase: '0.003', cancelAfterSeconds: 60, allocation: '0.10', reducedAllocation: '0.05',
      maximumPositions: 3, maximumExposure: '0.30', stopFraction: '0.02', targetFraction: '0.04',
      maximumRoundTripCost: '0.004', dailyLossLimit: '0.01', reduceDrawdown: '0.02', restoreDrawdown: '0.01',
      timezone: 'Europe/Berlin', entriesEnabled: false });
    expect(CONFIG.accountId).toBe('metamask-strategy-v1');
  });
  it('has no execution or market fallback and cannot arm an unconfigured host', async () => {
    const fetcher = vi.fn(() => { throw new Error('no network should be requested'); });
    vi.stubGlobal('fetch', fetcher);
    expect(await connectedVenue()).toBeNull();
    expect(await configuredSymbols(NOW)).toEqual([]);
    expect(await runHost()).toMatchObject({ status: 'blocked', reason: 'wallet_execution_transport_missing' });
    expect(await entrySwitch(true)).toMatchObject({ status: 'blocked', entriesEnabled: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not treat a swap or missing cancellation as the original limit-entry semantics', () => {
    const binding = testWalletBinding();
    expect(walletBindingIssue(binding, NOW)).toBeNull();
    binding.semantics.cancelRemainder = false;
    expect(walletBindingIssue(binding, NOW)).toBe('wallet_limit_cancellation_unsupported');
    binding.semantics.cancelRemainder = true; binding.semantics.limitOrders = false;
    expect(walletBindingIssue(binding, NOW)).toBe('wallet_limit_cancellation_unsupported');
  });
  it('blocks every host write path on stale connection configuration before invoking a provider', async () => {
    const source = { ...testWalletSource(), client: { getBalances: vi.fn(async () => []), getOrders: vi.fn(async () => []) },
      instruments: vi.fn(async () => []), candles: vi.fn(async () => []), market: vi.fn() };
    installWalletExecutionSource(source); vi.stubEnv('MIRSAD_ORDER_CONNECTION', 'removed-venue');
    for (const result of [await runHost(), await handleDeadline('a'.repeat(64)), await entrySwitch(true), await runProtection()]) {
      expect(result).toMatchObject({ status: 'blocked', reason: 'invalid_order_connection' });
    }
    expect(source.client.getBalances).not.toHaveBeenCalled(); expect(source.instruments).not.toHaveBeenCalled();
    const venue = new ConnectedWalletVenue(source, () => NOW);
    await expect(venue.submit()).rejects.toThrow('invalid_order_connection');
  });
  it('requires EUR identity, explicit token mapping and unexpired owner authority', () => {
    const binding = testWalletBinding();
    expect(walletBindingIssue(undefined, NOW)).toBe('wallet_market_mapping_missing');
    expect(walletBindingIssue({ ...binding, quoteCurrency: 'USD' as 'EUR' }, NOW)).toBe('wallet_identity_invalid');
    expect(walletBindingIssue({ ...binding, expiresAt: NOW }, NOW)).toBe('wallet_grant_outside_validity');
    expect(walletBindingIssue({ ...binding, markets: [{ ...binding.markets[0], quoteToken: binding.owner }] }, NOW))
      .toBe('wallet_market_mapping_invalid');
  });
  it('separates owner, chain and token mappings in the strategy ledger identity', () => {
    const a = testWalletBinding(), identity = walletBindingIdentity(a);
    expect(walletBindingIdentity({ ...a, chainId: 1 })).not.toBe(identity);
    expect(walletBindingIdentity({ ...a, owner: '0x9999999999999999999999999999999999999999' })).not.toBe(identity);
    expect(walletBindingIdentity({ ...a, markets: [{ ...a.markets[0], baseToken: a.owner }, ...a.markets.slice(1)] })).not.toBe(identity);
  });
  it('fails readiness for a revoked grant or missing gas-inclusive accounting', async () => {
    const base = { ...testWalletSource(), journal: {} as Journal,
      client: { getBalances: async () => [], getOrders: async () => [], getOrder: vi.fn(), submitOrder: vi.fn(), cancelOrder: vi.fn(),
        getOrderBook: vi.fn(), getValuationCandles: vi.fn(), getTransaction: vi.fn(), getTransactionsPage: vi.fn() },
      instruments: async () => [], candles: async () => [], market: vi.fn() };
    const revoked = new ConnectedWalletVenue({ ...base, verifyGrant: async () => false }, () => NOW);
    expect(await revoked.capabilities()).toMatchObject({ fencedWrites: false, idempotentOrders: false, entryRiskData: false });
    const noGas = new ConnectedWalletVenue({ ...base, gasCostsIncluded: false }, () => NOW);
    expect(await noGas.capabilities()).toMatchObject({ entryRiskData: false });
  });
  it('does not certify account readiness from method availability alone', () => {
    const snapshot = account();
    expect(accountEntryBlockers(snapshot, initialState().risk, NOW)).toEqual([]);
    snapshot.dataBlockers = ['accounting_evidence_missing'];
    expect(accountEntryBlockers(snapshot, initialState().risk, NOW)).toContain('accounting_evidence_missing');
    snapshot.dataBlockers = []; snapshot.valuationComplete = false;
    expect(accountEntryBlockers(snapshot, initialState().risk, NOW)).toContain('account_valuation_missing');
    snapshot.valuationComplete = true; snapshot.equityEur = '900';
    expect(accountEntryBlockers(snapshot, initialState().risk, NOW)).toContain('risk_valuation_mismatch');
  });
  it('redacts a secret-bearing provider exception from readiness and owner activation results', async () => {
    const secret = 'https://rpc.invalid/?apiKey=isolated-secret-sentinel';
    const source = { ...testWalletSource(), client: { getBalances: vi.fn(async () => { throw new Error(secret); }),
      getOrders: async () => [], getOrder: vi.fn(), submitOrder: vi.fn(), cancelOrder: vi.fn(), getOrderBook: vi.fn(),
      getValuationCandles: vi.fn(), getTransaction: vi.fn(), getTransactionsPage: vi.fn() },
      instruments: async () => [], candles: async () => [], market: vi.fn() };
    installWalletExecutionSource(source);
    vi.spyOn(ConnectedWalletVenue.prototype, 'refreshAccounting').mockResolvedValue();
    const result = await refreshReadiness();
    expect(result).toMatchObject({ ready: false, reason: 'wallet_account_unavailable' });
    expect(JSON.stringify(result)).not.toContain(secret);
    const current = Math.floor(Date.now() / 1000);
    source.binding.startsAt = current - 10; source.binding.expiresAt = current + 3600;
    source.verifyGrant = vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(new Error(secret));
    vi.stubEnv('EXECUTION_DEADLINE_URL', 'https://timer.invalid'); vi.stubEnv('EXECUTION_SCHEDULER_TOKEN', 'test');
    vi.spyOn(hostJournal, 'acquire').mockResolvedValue({ key: `execution:v1:${CONFIG.accountId}:lock`, owner: '00000000-0000-4000-8000-000000000001' });
    vi.spyOn(hostJournal, 'release').mockResolvedValue();
    const activation = await entrySwitch(true);
    expect(activation).toMatchObject({ status: 'blocked', reason: 'wallet_grant_unverified', entriesEnabled: false });
    expect(JSON.stringify(activation)).not.toContain(secret);
  });
  it('redacts provider exceptions from cycle results and durable audit events', async () => {
    const secret = 'https://rpc.invalid/?apiKey=isolated-secret-sentinel';
    const event = vi.fn(async () => {}), lease = { key: 'test-lock', owner: 'test-owner' };
    const journal = { acquire: async () => lease, release: async () => {}, state: async () => initialState(),
      protections: async () => [], event, save: async () => {}, renew: async () => {} } as unknown as Journal;
    const port = { accountId: CONFIG.accountId, candles: async () => { throw new Error(secret); },
      capabilities: async () => ({ idempotentOrders: false }), reconcile: async () => {},
      account: async () => { throw new Error(secret); } } as unknown as VenuePort;
    const result = await cycle(port, journal, ['AAA-EUR'], () => NOW);
    expect(result).toMatchObject({ status: 'blocked', reason: 'cycle_failed' });
    expect(JSON.stringify([result, event.mock.calls])).not.toContain(secret);
  });
  it('keeps the independent testnet pilot disabled without an explicit flag', () => {
    vi.stubEnv('VERCEL_ENV', 'production'); vi.stubEnv('MIRSAD_WALLET_TESTNET_ENABLED', undefined);
    expect(trialEnabled()).toBe(false);
    vi.stubEnv('MIRSAD_WALLET_TESTNET_ENABLED', 'true'); expect(trialEnabled()).toBe(true);
    vi.stubEnv('MIRSAD_ORDER_CONNECTION', 'removed-venue'); expect(trialEnabled()).toBe(false);
  });
});

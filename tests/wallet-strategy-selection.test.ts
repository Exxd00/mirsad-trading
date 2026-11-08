import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, ensureSchema, query, transaction } from '../src/lib/db';
import { CONFIG } from '../src/lib/execution/v1/model';
import type { WalletVenueSource } from '../src/lib/execution/v1/wallet-venue';
import { installWalletExecutionSource, walletExecutionSource, type WalletExecutionBinding } from '../src/lib/wallet/execution-connection';
import { loadStrategySelectionPolicy, parseStrategySelectionPolicy, resolveStrategySelectionSymbols, saveStrategySelectionPolicy,
  STRATEGY_SELECTION_KEY, type StrategySelectionPolicy } from '../src/lib/wallet/strategy-selection';

const NOW = Date.parse('2026-11-08T12:00:00Z') / 1000, stamp = (seconds: number) => new Date(seconds * 1000).toISOString();
const addr = (digit: string) => '0x' + digit.repeat(40);
const policy = (mode: 'manual' | 'opportunities' = 'manual'): StrategySelectionPolicy => ({ schemaVersion: 1,
  accountId: CONFIG.accountId, strategyVersion: CONFIG.strategyVersion, mode });
function source() {
  const binding: WalletExecutionBinding = { chainId: 84532, owner: addr('1'), quoteToken: addr('2'), quoteDecimals: 6,
    quoteCurrency: 'EUR', grantId: 'isolated-reviewed-grant', startsAt: NOW - 60, expiresAt: NOW + 3600,
    markets: ['AAA-EUR', 'BBB-EUR', 'CCC-EUR'].map((symbol, index) => ({ symbol, baseToken: addr(String(index + 3)),
      baseDecimals: 18, quoteToken: addr('2') })),
    semantics: { limitOrders: true, cancelRemainder: true, idempotentSubmission: true, confirmedReceipts: true, fencedWrites: true } };
  const unused = vi.fn(async () => { throw new Error('Candidate selection must not read markets or execute trades'); });
  const verifyGrant = vi.fn(async (_binding: WalletExecutionBinding) => true);
  const value: WalletVenueSource & { binding: WalletExecutionBinding; verifyGrant: typeof verifyGrant } = {
    binding, verifyGrant, client: { getBalances: unused, getOrders: unused, submitOrder: unused, cancelOrder: unused },
    instruments: unused, market: unused, candles: unused };
  return { value, verifyGrant, unused };
}
async function put(key: string, value: unknown) {
  await query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [key, JSON.stringify(value)]);
}
async function settings() { return (await query('SELECT key,value,updated_at FROM app_settings ORDER BY key')).rows; }

beforeAll(async () => {
  await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL', ''); vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); vi.stubEnv('MIRSAD_RETIRE_LEGACY_CONNECTION', undefined);
  await ensureSchema();
});
beforeEach(async () => {
  await query('TRUNCATE app_settings'); installWalletExecutionSource(null);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network in isolated selection policy test'); }));
});
afterEach(() => {
  try { expect(fetch).not.toHaveBeenCalled(); }
  finally { installWalletExecutionSource(null); vi.useRealTimers(); vi.unstubAllGlobals(); }
});
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });

describe('explicit versioned selection policy', () => {
  it('accepts only the two explicit modes without inventing an automatic default', () => {
    expect(parseStrategySelectionPolicy(policy())).toEqual(policy());
    expect(parseStrategySelectionPolicy(policy('opportunities'))).toEqual(policy('opportunities'));
  });
  it.each([null, {}, { mode: 'opportunities' }, { ...policy(), mode: 'automatic' }, { ...policy(), schemaVersion: 2 },
    { ...policy(), accountId: 'discovery-paper' }, { ...policy(), strategyVersion: 'another-strategy' },
    { ...policy(), enabled: true }, { ...policy(), approved: true }, { ...policy(), tokens: [addr('3')] }])(
    'rejects missing, unrelated or self-authorizing policy input %j', input => {
      expect(() => parseStrategySelectionPolicy(input)).toThrow(/^wallet_strategy_selection_invalid$/);
    });
  it('rejects invalid runtime policy input instead of treating it as opportunities or manual fallback', async () => {
    const current = source(); installWalletExecutionSource(current.value);
    await expect(resolveStrategySelectionSymbols({ ...policy('opportunities'), approved: true } as StrategySelectionPolicy,
      ['AAA-EUR'], () => NOW)).rejects.toThrow(/^wallet_strategy_selection_invalid$/);
    expect(current.verifyGrant).not.toHaveBeenCalled();
  });
});

describe('durable selection policy without activation', () => {
  it('reads missing configuration as missing and makes no migration or default write', async () => {
    await put('wallet:strategy:watchlist', []); await put('watchlist', ['OLD-EUR']);
    await put('discovery:wallet:v1:cohort', ['PAPER-EUR']);
    const before = await settings();
    expect(await transaction(loadStrategySelectionPolicy)).toBeNull(); expect(await settings()).toEqual(before);
    expect(walletExecutionSource()).toBeNull();
  });
  it('round-trips revision and UTC updatedAt while preserving manual, historical, profile, paper and runtime settings', async () => {
    for (const [key, value] of [
      ['wallet:strategy:watchlist', []], ['watchlist', ['OLD-EUR']], ['wallet:strategy:profile:v1', { configured: 'isolated-existing-profile' }],
      ['discovery:wallet:v1:cohort', ['PAPER-EUR']], [`execution:v1:${CONFIG.accountId}:state`, { entriesEnabled: false, executionArmed: false }],
      ['live_enabled', false],
    ] as const) await put(key, value);
    const before = await settings(), saved = await transaction(tx => saveStrategySelectionPolicy(tx, policy('opportunities'), null, NOW));
    expect(saved).toEqual({ storageVersion: 1, revision: 1, updatedAt: stamp(NOW), policy: policy('opportunities') });
    expect(await transaction(loadStrategySelectionPolicy)).toEqual(saved);
    const stored = await query<{ updated_at: Date | string }>('SELECT updated_at FROM app_settings WHERE key=$1', [STRATEGY_SELECTION_KEY]);
    expect(new Date(stored.rows[0].updated_at).toISOString()).toBe(saved.updatedAt);
    expect((await settings()).filter(row => row.key !== STRATEGY_SELECTION_KEY)).toEqual(before);
    expect(walletExecutionSource()).toBeNull(); expect(await resolveStrategySelectionSymbols(saved.policy, [], () => NOW)).toEqual([]);
  });
  it('uses compare-and-set for both creation and racing revisions without losing the winning mode', async () => {
    await transaction(tx => saveStrategySelectionPolicy(tx, policy(), null, NOW));
    await expect(transaction(tx => saveStrategySelectionPolicy(tx, policy('opportunities'), null, NOW + 1)))
      .rejects.toThrow(/^wallet_strategy_selection_revision_conflict$/);
    const outcomes = await Promise.allSettled([
      transaction(tx => saveStrategySelectionPolicy(tx, policy('opportunities'), 1, NOW + 2)),
      transaction(tx => saveStrategySelectionPolicy(tx, policy(), 1, NOW + 3)),
    ]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    const failure = outcomes.find(outcome => outcome.status === 'rejected');
    expect(failure).toMatchObject({ status: 'rejected', reason: { message: 'wallet_strategy_selection_revision_conflict' } });
    const winner = outcomes.find(outcome => outcome.status === 'fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('Missing isolated CAS winner');
    expect(winner.value.revision).toBe(2); expect(await transaction(loadStrategySelectionPolicy)).toEqual(winner.value);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER])('rejects invalid expected revision %s before changing stored policy', async revision => {
    await transaction(tx => saveStrategySelectionPolicy(tx, policy(), null, NOW)); const before = await settings();
    await expect(transaction(tx => saveStrategySelectionPolicy(tx, policy('opportunities'), revision, NOW + 1)))
      .rejects.toThrow(/^wallet_strategy_selection_revision_invalid$/);
    expect(await settings()).toEqual(before);
  });
  it.each([-1, 1.5, Number.NaN, 253_402_300_800])('rejects invalid write time %s without storing any automatic policy', async now => {
    await expect(transaction(tx => saveStrategySelectionPolicy(tx, policy('opportunities'), null, now)))
      .rejects.toThrow(/^wallet_strategy_selection_time_invalid$/);
    expect(await transaction(loadStrategySelectionPolicy)).toBeNull();
  });
  it.each([null, { storageVersion: 2, revision: 1, updatedAt: stamp(NOW), policy: policy('opportunities') },
    { storageVersion: 1, revision: 0, updatedAt: stamp(NOW), policy: policy('opportunities') },
    { storageVersion: 1, revision: 1, updatedAt: '2026-02-30T12:00:00.000Z', policy: policy('opportunities') },
    { storageVersion: 1, revision: 1, updatedAt: stamp(NOW), policy: { ...policy('opportunities'), verified: true, privateKey: 'isolated-invalid-marker' } }])(
    'fails closed on corrupt stored policy rather than recovering an automatic mode: %j', async value => {
      await put(STRATEGY_SELECTION_KEY, value); const before = await settings();
      await expect(transaction(loadStrategySelectionPolicy)).rejects.toThrow(/^wallet_strategy_selection_stored_invalid$/);
      expect(await settings()).toEqual(before); expect(walletExecutionSource()).toBeNull();
    });
  it('retains an explicit opportunities policy and unchanged manual selection after a durable database restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mirsad-selection-test-'));
    await closeDatabase(); vi.stubEnv('LOCAL_DATABASE_PATH', directory);
    try {
      await ensureSchema(); await put('wallet:strategy:watchlist', []);
      const saved = await transaction(tx => saveStrategySelectionPolicy(tx, policy('opportunities'), null, NOW));
      await closeDatabase();
      expect(await transaction(loadStrategySelectionPolicy)).toEqual(saved);
      expect((await query('SELECT value FROM app_settings WHERE key=$1', ['wallet:strategy:watchlist'])).rows).toEqual([{ value: [] }]);
      expect(walletExecutionSource()).toBeNull();
    } finally {
      await closeDatabase(); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://');
      const absolute = resolve(directory);
      if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('mirsad-selection-test-')) throw new Error('Unsafe isolated selection cleanup path');
      await rm(absolute, { recursive: true, force: true }); await ensureSchema();
    }
  });
});

describe('approved candidate universe for the existing strategy', () => {
  it('retains manual selection for missing policy and explicit manual mode, including an empty watchlist', async () => {
    const current = source(); installWalletExecutionSource(current.value);
    for (const saved of [null, policy()]) {
      expect(await resolveStrategySelectionSymbols(saved, [], () => NOW)).toEqual([]);
      expect(await resolveStrategySelectionSymbols(saved, undefined, () => NOW)).toEqual([]);
      expect(await resolveStrategySelectionSymbols(saved, ['BBB-EUR', 'PAPER-EUR', 'BBB-EUR', null, 7], () => NOW)).toEqual(['BBB-EUR']);
    }
    expect(current.unused).not.toHaveBeenCalled();
  });
  it('uses every verified mapped market in opportunities mode regardless of the manual watchlist or paper cohort', async () => {
    const current = source(); installWalletExecutionSource(current.value);
    await put('wallet:strategy:watchlist', []); await put('watchlist', ['OLD-EUR']); await put('discovery:wallet:v1:cohort', ['PAPER-EUR']);
    const before = await settings();
    expect(await resolveStrategySelectionSymbols(policy('opportunities'), [], () => NOW)).toEqual(['AAA-EUR', 'BBB-EUR', 'CCC-EUR']);
    expect(current.verifyGrant).toHaveBeenCalledExactlyOnceWith(current.value.binding);
    expect(current.unused).not.toHaveBeenCalled(); expect(await settings()).toEqual(before); expect(walletExecutionSource()).toBe(current.value);
  });
  it('intersects CONFIG restrictions with the approved universe without adding configured or manually selected tokens', async () => {
    const current = source(); installWalletExecutionSource(current.value);
    const symbols = CONFIG.symbols as string[], original = [...symbols];
    try {
      symbols.splice(0, symbols.length, 'CCC-EUR', 'PAPER-EUR');
      expect(await resolveStrategySelectionSymbols(policy('opportunities'), ['PAPER-EUR'], () => NOW)).toEqual(['CCC-EUR']);
      expect(await resolveStrategySelectionSymbols(policy(), ['AAA-EUR', 'PAPER-EUR'], () => NOW)).toEqual([]);
    } finally { symbols.splice(0, symbols.length, ...original); }
  });
  it('does not use an absent source, profile configuration or unverified binding as execution authority', async () => {
    await put('wallet:strategy:profile:v1', { markets: [{ symbol: 'PAPER-EUR' }], verified: true });
    expect(await resolveStrategySelectionSymbols(policy('opportunities'), ['PAPER-EUR'], () => NOW)).toEqual([]);
    const current = source(); installWalletExecutionSource({ ...current.value, verifyGrant: undefined });
    expect(await resolveStrategySelectionSymbols(policy('opportunities'), [], () => NOW)).toEqual([]);
    installWalletExecutionSource({ ...current.value, binding: undefined });
    expect(await resolveStrategySelectionSymbols(policy('opportunities'), [], () => NOW)).toEqual([]);
    expect(current.verifyGrant).not.toHaveBeenCalled(); expect(current.unused).not.toHaveBeenCalled();
  });
  it.each(['revoked', 'unavailable', 'expired', 'future', 'mapping', 'cancel'] as const)(
    'authorizes no candidates when the installed binding is %s', async issue => {
      const current = source(); installWalletExecutionSource(current.value);
      if (issue === 'revoked') current.verifyGrant.mockResolvedValue(false);
      if (issue === 'unavailable') current.verifyGrant.mockRejectedValue(new Error('isolated-private-provider-marker'));
      if (issue === 'expired') current.value.binding.expiresAt = NOW;
      if (issue === 'future') current.value.binding.startsAt = NOW + 1;
      if (issue === 'mapping') current.value.binding.markets = [];
      if (issue === 'cancel') current.value.binding.semantics.cancelRemainder = false;
      expect(await resolveStrategySelectionSymbols(policy('opportunities'), ['AAA-EUR'], () => NOW)).toEqual([]);
      expect(current.unused).not.toHaveBeenCalled();
    });
  it.each(['source', 'market', 'grant', 'verifier'] as const)('discards a grant result if the %s changes while verification is pending', async changed => {
    const current = source(); let finish!: (value: boolean) => void;
    current.verifyGrant.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve; }));
    installWalletExecutionSource(current.value);
    const pending = resolveStrategySelectionSymbols(policy('opportunities'), [], () => NOW);
    if (changed === 'source') installWalletExecutionSource(source().value);
    if (changed === 'market') current.value.binding.markets[0].baseToken = addr('9');
    if (changed === 'grant') current.value.binding.grantId = 'isolated-rotated-grant';
    if (changed === 'verifier') current.value.verifyGrant = vi.fn(async () => true);
    finish(true); expect(await pending).toEqual([]); expect(current.unused).not.toHaveBeenCalled();
  });
  it('rechecks the live clock and rejects a grant that expires while verification is pending', async () => {
    const current = source(); let checkedAt = NOW, finish!: (value: boolean) => void;
    current.verifyGrant.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve; }));
    installWalletExecutionSource(current.value);
    const pending = resolveStrategySelectionSymbols(policy('opportunities'), [], () => checkedAt);
    checkedAt = current.value.binding.expiresAt; finish(true);
    expect(await pending).toEqual([]); expect(current.unused).not.toHaveBeenCalled();
  });
  it('bounds a hung verification, ignores its late result and permits a fresh verification afterward', async () => {
    vi.useFakeTimers(); const current = source(); let finish!: (value: boolean) => void;
    current.verifyGrant.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
    installWalletExecutionSource(current.value);
    const pending = resolveStrategySelectionSymbols(policy('opportunities'), [], () => NOW);
    await vi.advanceTimersByTimeAsync(5000); expect(await pending).toEqual([]); expect(vi.getTimerCount()).toBe(0);
    finish(true); await Promise.resolve();
    expect(await resolveStrategySelectionSymbols(policy('opportunities'), [], () => NOW)).toEqual(['AAA-EUR', 'BBB-EUR', 'CCC-EUR']);
    expect(current.verifyGrant).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0); expect(current.unused).not.toHaveBeenCalled();
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, ensureSchema, query, transaction, type SqlExecutor } from '../src/lib/db';
import { CONFIG } from '../src/lib/execution/v1/model';
import { walletExecutionSource } from '../src/lib/wallet/execution-connection';
import { loadStrategyProfile, parseStrategyProfile, parseStrategyProfileJson, saveStrategyProfile,
  STRATEGY_PROFILE_KEY } from '../src/lib/wallet/strategy-profile';

const NOW = Date.parse('2026-11-08T12:00:00Z') / 1000;
const addr = (digit: string) => '0x' + digit.repeat(40);
const profile = () => ({ schemaVersion: 1, kind: 'owner-strategy-profile', accountId: CONFIG.accountId,
  strategyVersion: CONFIG.strategyVersion, chainId: 84532, owner: addr('1'), executor: addr('2'),
  quoteToken: addr('3'), quoteDecimals: 6,
  markets: [{ symbol: 'AAA-EUR', baseToken: addr('4'), baseDecimals: 18, quoteToken: addr('3') },
    { symbol: 'BBB-EUR', baseToken: addr('5'), baseDecimals: 6, quoteToken: addr('3') }],
  accountingCurrency: 'EUR', conversion: { quoteUnit: 'USDC', sourceId: 'isolated-fx-source',
    methodologyReference: 'urn:mirsad:fx-methodology:v1', evidenceReference: 'https://example.invalid/docs/eur-conversion' },
  authority: { grantReference: 'urn:mirsad:isolated-owner-grant:v1', revocationReference: 'urn:mirsad:isolated-revocation:v1',
    startsAt: NOW - 60, expiresAt: NOW + 3600,
    scope: { recipient: addr('1'), contracts: [addr('6')], tokens: [addr('3'), addr('4'), addr('5')],
      actions: ['limit-entry', 'cancel-remainder', 'managed-exit'] } },
  implementation: { kind: 'provider-neutral', version: 'candidate-v1', status: 'inactive' } });

beforeAll(async () => {
  await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL', ''); vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); vi.stubEnv('MIRSAD_RETIRE_LEGACY_CONNECTION', undefined);
  await ensureSchema();
});
beforeEach(async () => { await query('TRUNCATE app_settings'); });
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });

describe('strict configuration-only wallet strategy profile', () => {
  it('parses explicit profile JSON without treating documented EUR conversion or candidate configuration as verification', () => {
    const input = profile(), parsed = parseStrategyProfileJson(JSON.stringify(input));
    expect(parsed).toEqual(input); expect(parsed.accountingCurrency).toBe('EUR'); expect(parsed.conversion.quoteUnit).toBe('USDC');
    expect(() => parseStrategyProfile({ ...input, accountingCurrency: 'USD' })).toThrow('wallet_strategy_profile_invalid');
    expect(walletExecutionSource()).toBeNull();
    expect(() => parseStrategyProfileJson('{"privateKey":"isolated-secret"')).toThrow(/^wallet_strategy_profile_invalid$/);
    expect(() => parseStrategyProfileJson(' '.repeat(65537))).toThrow(/^wallet_strategy_profile_invalid$/);
  });
  it('requires a complete profile and rejects a browser snapshot, connected flag, raw signature and private material', () => {
    for (const value of [{}, { address: addr('1'), chainId: '84532', nativeBalance: '100' },
      { status: 'connected', wallet: { address: addr('1'), chainId: '84532', nativeBalance: '100' } },
      { ...profile(), connected: true }, { ...profile(), privateKey: 'isolated-secret' },
      { ...profile(), authority: { ...profile().authority, signature: 'isolated-signature' } },
      { ...profile(), authority: { ...profile().authority, verified: true } }]) {
      expect(() => parseStrategyProfile(value)).toThrow(/^wallet_strategy_profile_invalid$/);
    }
  });
  it.each([
    ['chain', (p: ReturnType<typeof profile>) => { p.chainId = 0; }],
    ['unsafe chain', (p: ReturnType<typeof profile>) => { p.chainId = Number.MAX_SAFE_INTEGER + 1; }],
    ['zero owner', (p: ReturnType<typeof profile>) => { p.owner = addr('0'); }],
    ['same owner and executor', (p: ReturnType<typeof profile>) => { p.executor = p.owner; }],
    ['invalid decimals', (p: ReturnType<typeof profile>) => { p.markets[0].baseDecimals = 256; }],
    ['fractional decimals', (p: ReturnType<typeof profile>) => { p.quoteDecimals = 6.5; }],
    ['duplicate symbol', (p: ReturnType<typeof profile>) => { p.markets[1].symbol = p.markets[0].symbol; }],
    ['aliased token', (p: ReturnType<typeof profile>) => { p.markets[1].baseToken = p.markets[0].baseToken; }],
    ['base/quote collision', (p: ReturnType<typeof profile>) => { p.markets[0].baseToken = p.quoteToken; }],
    ['wrong market quote', (p: ReturnType<typeof profile>) => { p.markets[0].quoteToken = addr('7'); }],
    ['wrong strategy', (p: ReturnType<typeof profile>) => { p.strategyVersion = 'another-strategy'; }],
    ['wrong account', (p: ReturnType<typeof profile>) => { p.accountId = 'another-ledger'; }],
    ['reversed lifetime', (p: ReturnType<typeof profile>) => { p.authority.expiresAt = p.authority.startsAt; }],
    ['wrong recipient', (p: ReturnType<typeof profile>) => { p.authority.scope.recipient = addr('7'); }],
    ['duplicate contract', (p: ReturnType<typeof profile>) => { p.authority.scope.contracts.push(p.authority.scope.contracts[0]); }],
    ['broad token scope', (p: ReturnType<typeof profile>) => { p.authority.scope.tokens.push(addr('7')); }],
    ['missing token scope', (p: ReturnType<typeof profile>) => { p.authority.scope.tokens.pop(); }],
    ['duplicate action', (p: ReturnType<typeof profile>) => { p.authority.scope.actions[1] = 'limit-entry'; }],
    ['missing evidence', (p: ReturnType<typeof profile>) => { p.conversion.evidenceReference = ''; }],
    ['credential-bearing reference', (p: ReturnType<typeof profile>) => { p.conversion.evidenceReference = 'https://private:secret@example.invalid/rates'; }],
    ['query-bearing reference', (p: ReturnType<typeof profile>) => { p.conversion.evidenceReference = 'https://example.invalid/rates?key=secret'; }],
    ['whitespace-bearing reference', (p: ReturnType<typeof profile>) => { p.conversion.evidenceReference = ' https://example.invalid/rates '; }],
    ['active provider flag', (p: ReturnType<typeof profile>) => { p.implementation.status = 'active'; }],
  ])('rejects conflicting %s configuration', (_name, change) => {
    const input = profile(); change(input);
    expect(() => parseStrategyProfile(input)).toThrow(/^wallet_strategy_profile_invalid$/);
  });
  it('canonicalizes address case before detecting asset aliases', () => {
    const input = profile(); input.markets[0].baseToken = addr('a'); input.markets[1].baseToken = '0x' + 'A'.repeat(40);
    input.authority.scope.tokens = [input.quoteToken, input.markets[0].baseToken, input.markets[1].baseToken];
    expect(() => parseStrategyProfile(input)).toThrow('wallet_strategy_profile_invalid');
  });
});

describe('profile persistence without execution activation', () => {
  it('has no stored/default network, owner, asset map or permission when configuration is missing', async () => {
    expect(await transaction(tx => loadStrategyProfile(tx, NOW))).toBeNull();
    expect((await query('SELECT key FROM app_settings')).rows).toEqual([]); expect(walletExecutionSource()).toBeNull();
  });
  it('saves and reads an explicitly versioned profile while preserving the authoritative watchlist and runtime state', async () => {
    const watchlist = ['BBB-EUR'], runtime = { entriesEnabled: false, walletIdentity: 'existing-isolated-wallet' };
    await query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb),($3,$4::jsonb)',
      ['wallet:strategy:watchlist', JSON.stringify(watchlist), 'execution:v1:metamask-strategy-v1:state', JSON.stringify(runtime)]);
    const saved = await transaction(tx => saveStrategyProfile(tx, profile(), null, NOW));
    expect(saved).toMatchObject({ storageVersion: 1, revision: 1, configurationStatus: 'configuration-only', authorityStatus: 'unverified', lifetimeStatus: 'within-window' });
    expect(saved.profile).toEqual(profile()); expect(await transaction(tx => loadStrategyProfile(tx, NOW))).toEqual(saved);
    expect((await query('SELECT value FROM app_settings WHERE key=$1', ['wallet:strategy:watchlist'])).rows).toEqual([{ value: watchlist }]);
    expect((await query('SELECT value FROM app_settings WHERE key=$1', ['execution:v1:metamask-strategy-v1:state'])).rows).toEqual([{ value: runtime }]);
    expect(walletExecutionSource()).toBeNull();
  });
  it('preserves an explicitly empty watchlist and keeps a CoW candidate inactive', async () => {
    await query("INSERT INTO app_settings(key,value) VALUES('wallet:strategy:watchlist','[]')");
    const input = profile(); input.implementation.kind = 'cow-candidate';
    const saved = await transaction(tx => saveStrategyProfile(tx, input, null, NOW));
    expect(saved.profile.implementation).toMatchObject({ kind: 'cow-candidate', status: 'inactive' });
    expect(saved.authorityStatus).toBe('unverified'); expect(walletExecutionSource()).toBeNull();
    expect((await query("SELECT value FROM app_settings WHERE key='wallet:strategy:watchlist'")).rows).toEqual([{ value: [] }]);
  });
  it('uses compare-and-set revisions so a stale writer cannot replace newer owner configuration', async () => {
    await transaction(tx => saveStrategyProfile(tx, profile(), null, NOW));
    const changed = profile(); changed.authority.revocationReference = 'urn:mirsad:revocation:v2';
    const second = await transaction(tx => saveStrategyProfile(tx, changed, 1, NOW)); expect(second.revision).toBe(2);
    await expect(transaction(tx => saveStrategyProfile(tx, profile(), 1, NOW))).rejects.toThrow('wallet_strategy_profile_revision_conflict');
    await expect(transaction(tx => saveStrategyProfile(tx, profile(), null, NOW))).rejects.toThrow('wallet_strategy_profile_revision_conflict');
    expect(await transaction(tx => loadStrategyProfile(tx, NOW))).toEqual(second);
  });
  it('requires valid revision/time inputs and rejects already-expired writes before any SQL', async () => {
    const tx = { query: vi.fn() } as unknown as SqlExecutor;
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      await expect(saveStrategyProfile(tx, profile(), revision, NOW)).rejects.toThrow('wallet_strategy_profile_revision_invalid');
    }
    await expect(saveStrategyProfile(tx, profile(), null, NaN)).rejects.toThrow('wallet_strategy_profile_time_invalid');
    await expect(saveStrategyProfile(tx, profile(), null, NOW + 3600)).rejects.toThrow('wallet_strategy_profile_expired');
    expect(tx.query).not.toHaveBeenCalled();
  });
  it('retains expired/future configuration as unverified instead of manufacturing current authority', async () => {
    const input = profile(); input.authority.startsAt = NOW + 60;
    expect(await transaction(tx => saveStrategyProfile(tx, input, null, NOW))).toMatchObject({ lifetimeStatus: 'not-started', authorityStatus: 'unverified' });
    expect(await transaction(tx => loadStrategyProfile(tx, NOW + 3600))).toMatchObject({ lifetimeStatus: 'expired', authorityStatus: 'unverified' });
    expect(walletExecutionSource()).toBeNull();
  });
  it('rejects corrupt or unknown-version stored records instead of falling back to a browser connection', async () => {
    for (const value of [{ storageVersion: 2, revision: 1, profile: profile() },
      { storageVersion: 1, revision: 0, profile: profile() }, { connected: true, address: addr('1'), chainId: 84532 }]) {
      await query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',
        [STRATEGY_PROFILE_KEY, JSON.stringify(value)]);
      await expect(transaction(tx => loadStrategyProfile(tx, NOW))).rejects.toThrow('wallet_strategy_profile_stored_invalid');
    }
  });
  it('round-trips the profile through durable storage across a database close and restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mirsad-profile-test-'));
    await closeDatabase(); vi.stubEnv('LOCAL_DATABASE_PATH', directory);
    try {
      await ensureSchema(); const saved = await transaction(tx => saveStrategyProfile(tx, profile(), null, NOW));
      await closeDatabase();
      expect(await transaction(tx => loadStrategyProfile(tx, NOW + 1))).toEqual(saved);
      expect(walletExecutionSource()).toBeNull();
    } finally {
      await closeDatabase(); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://');
      const absolute = resolve(directory);
      if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('mirsad-profile-test-')) throw new Error('Unsafe isolated profile test cleanup path');
      await rm(absolute, { recursive: true, force: true });
    }
  });
});

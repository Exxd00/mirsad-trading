import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress, getContractAddress, keccak256, type Address, type Hex } from 'viem';
import { closeDatabase, ensureSchema, query } from '../src/lib/db';
import { hashPassword, issueLoginCsrf, login, sessionCookieName } from '../src/lib/auth';
import { encryptSecret } from '../src/lib/secrets';
import { CONFIG, type Intent } from '../src/lib/execution/v1/model';
import { COW_SETTLEMENT, COW_VAULT_RELAYER, cowOrderUid, type CowOrder } from '../src/lib/wallet/cow-order';
import { COINBASE_REFERENCE_PROVIDER, type CoinbaseMarketMapping } from '../src/lib/wallet/coinbase-market';
import { createAuthorityReview, type AuthorityReview } from '../src/lib/wallet/authority';
import { loadAuthority, saveAuthority, sealAuthoritySignature } from '../src/lib/wallet/authority-store';
import * as authorityEnvironment from '../src/lib/wallet/authority-environment';
import { expectedCowEnforcerRuntime } from '../src/lib/wallet/cow-artifact';
import { loadStrategyProfile, saveStrategyProfile } from '../src/lib/wallet/strategy-profile';
import { cowRuntimeArchiveKey, prepareCowSetup } from '../src/lib/wallet/cow-setup';
import { createCowPolicyDraft, cowPolicyOrderAppData } from '../src/lib/wallet/cow-policy';
import { ensureCowWalletSource } from '../src/lib/wallet/cow-bootstrap';
import type { CowExecutionOptions } from '../src/lib/wallet/cow-execution';
import type { CowOrderRecord } from '../src/lib/wallet/cow-execution-types';
import { CowSubmitApi } from '../src/lib/wallet/cow-submit-api';
import * as runtime from '../src/lib/wallet/cow-runtime-config';
import { installWalletExecutionSource, walletExecutionSource } from '../src/lib/wallet/execution-connection';
import { POST as setupPOST } from '../src/app/api/wallet/strategy/setup/route';
import manifest from '../src/lib/wallet/generated/mainnet-contracts.json';
import { authorityVerification } from './fixtures/wallet-authority';
import { AuthorityError } from '../src/lib/wallet/authority';
import { signal } from './execution-fixtures';
const feasibility = vi.hoisted(() => ({ guard: vi.fn() }));
vi.mock('../src/lib/wallet/cow-feasibility', () => ({ assertCowSetupFeasible: feasibility.guard }));
const constructed = vi.hoisted(() => ({ executions: [] as unknown[] }));
vi.mock('../src/lib/wallet/cow-execution', async original => {
  const actual = await original<typeof import('../src/lib/wallet/cow-execution')>();
  return { ...actual, CowExecution: class extends actual.CowExecution {
    constructor(options: CowExecutionOptions) {
      super(options);
      // Observation only: the production constructor and methods stay intact.
      constructed.executions.push(options);
    }
  } };
});

const NOW = Math.floor(Date.now() / 1000), ownerAccount = privateKeyToAccount(generatePrivateKey()), owner = ownerAccount.address;
const executorKey = generatePrivateKey(), executor = privateKeyToAccount(executorKey).address;
const signerKey = 'wallet:strategy:cow-executor:v1:' + (process.env.VERCEL_ENV || 'local');
const stateKey = `execution:v1:${CONFIG.accountId}:state`, origin = 'http://localhost:3000';
const password = 'isolated-bootstrap-password-A8!';
let expectedFetchCalls = 0;
function mapping(): CoinbaseMarketMapping {
  const m = { version: 1 as const, chainId: 1 as const, tokenAddress: manifest.contracts.weth9.toLowerCase() as Address, tokenDecimals: 18,
    currency: 'WETH', referenceCurrency: 'ETH', symbol: 'WETH-EUR', productId: 'ETH-EUR', provider: COINBASE_REFERENCE_PROVIDER,
    method: 'weth9-native-redemption-reference-v1' as const };
  const digest = createHash('sha256').update(JSON.stringify([m.version, m.chainId, m.tokenAddress, m.tokenDecimals, m.currency,
    m.referenceCurrency, m.symbol, m.productId, m.provider, m.method])).digest('hex');
  return { ...m, sourceId: 'coinbase-eur:v1:' + digest };
}
function config(): runtime.CowRuntimeConfig {
  return runtime.parseCowRuntime({ version: 1, profileRevision: 1, createdAt: NOW, manager: manifest.contracts.manager,
    implementation: manifest.contracts.implementation, enforcer: getContractAddress({ from: owner, nonce: 0n }), executorAddress: executor,
    terms: { id: randomUUID(), chainId: 1, owner, executor, quoteToken: manifest.contracts.quoteToken, startsAt: NOW - 60, expiresAt: NOW + 3600,
      maxOrderValiditySeconds: 300, maxQuotePerBuy: '1000000', maxQuoteTotal: '100000000', markets: [{ baseToken: manifest.contracts.weth9,
        maxBasePerSell: '1000000000000000000', maxBaseTotal: '1000000000000000000', buyFloorQuote: '10000000', buyFloorBase: '1000000000000000000',
        sellFloorBase: '1000000000000000000', sellFloorQuote: '100000' }] },
    tokenCodeHashes: { [manifest.contracts.quoteToken.toLowerCase()]: manifest.codeHashes.quoteToken, [manifest.contracts.weth9.toLowerCase()]: manifest.codeHashes.weth9 },
    mappings: [mapping()], gasLimits: { maxGas: '1500000', maxFeePerGasWei: '20000000000', maxPriorityFeePerGasWei: '2000000000', maxTransactionCostWei: '30000000000000000' } });
}
function profile(c: runtime.CowRuntimeConfig) {
  return { schemaVersion: 1, kind: 'owner-strategy-profile', accountId: CONFIG.accountId, strategyVersion: CONFIG.strategyVersion,
    chainId: 1, owner, executor, quoteToken: c.terms.quoteToken, quoteDecimals: 6, accountingCurrency: 'EUR',
    markets: [{ symbol: 'WETH-EUR', baseToken: c.terms.markets[0].baseToken, baseDecimals: 18, quoteToken: c.terms.quoteToken }],
    conversion: { ...runtime.COW_PROFILE_CONVERSION }, implementation: { kind: 'cow-candidate', version: 'cow-wallet-v1', status: 'inactive' },
    authority: { grantReference: 'urn:mirsad:grant:' + c.terms.id, revocationReference: 'urn:mirsad:close:' + c.terms.id,
      startsAt: c.terms.startsAt, expiresAt: c.terms.expiresAt, scope: { recipient: owner,
        contracts: [c.manager, c.enforcer, COW_SETTLEMENT, COW_VAULT_RELAYER], tokens: [c.terms.quoteToken, c.terms.markets[0].baseToken],
        actions: ['limit-entry', 'cancel-remainder', 'managed-exit'] } } };
}
async function put(key: string, value: unknown) {
  await query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [key, JSON.stringify(value)]);
}
async function seeded() {
  const c = config(); await saveStrategyProfile({ query }, profile(c), null, NOW); await put(runtime.COW_RUNTIME_KEY, c);
  await put(stateKey, { entriesEnabled: false, executionArmed: false, risk: { reduced: false, dailyHaltDate: null }, indicators: {}, pendingSignals: [] });
  return c;
}
function reviewFor(c: runtime.CowRuntimeConfig) {
  return createAuthorityReview({ id: randomUUID(), profileRevision: 1, now: NOW, preparation: { terms: c.terms,
    contracts: { manager: c.manager, implementation: c.implementation, enforcer: c.enforcer,
      settlement: COW_SETTLEMENT, vaultRelayer: COW_VAULT_RELAYER, release: 'test-v1', codeHashes: { manager: manifest.codeHashes.manager as Hex,
        implementation: manifest.codeHashes.implementation as Hex, settlement: manifest.codeHashes.settlement as Hex,
        vaultRelayer: manifest.codeHashes.vaultRelayer as Hex, enforcer: keccak256(expectedCowEnforcerRuntime(c.manager)) } },
    block: { number: '1', hash: ('0x' + 'a'.repeat(64)) as Hex, timestamp: NOW }, ownerMode: 'metamask-7702', tokenCodeHashes: c.tokenCodeHashes,
    allowances: [ { token: c.terms.quoteToken, current: c.terms.maxQuoteTotal, finiteAmount: c.terms.maxQuoteTotal },
      { token: c.terms.markets[0].baseToken, current: c.terms.markets[0].maxBaseTotal, finiteAmount: c.terms.markets[0].maxBaseTotal } ], blockers: [] } });
}
const settings = async () => (await query('SELECT key,value,updated_at FROM app_settings ORDER BY key')).rows;
beforeAll(async () => {
  await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL', ''); vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); vi.stubEnv('APP_ORIGIN', origin); vi.stubEnv('MIRSAD_RETIRE_LEGACY_CONNECTION', undefined);
  vi.stubEnv('ENCRYPTION_KEY', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='); vi.stubEnv('INITIAL_PASSWORD_HASH', await hashPassword(password));
  await ensureSchema();
});
beforeEach(async () => {
  await query('TRUNCATE app_settings,app_owner,app_sessions,auth_rate_limits,audit_events,order_intents RESTART IDENTITY');
  installWalletExecutionSource(null);
  expectedFetchCalls = 0; constructed.executions.length = 0;
  feasibility.guard.mockReset(); feasibility.guard.mockResolvedValue({ decision: 'eligible-for-setup' });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No financial network or RPC may run during isolated bootstrap tests'); }));
});
afterEach(() => { try { expect(fetch).toHaveBeenCalledTimes(expectedFetchCalls); } finally { installWalletExecutionSource(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); } });
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });
describe('cold start with durable wallet configuration', () => {
  it('rejects unproven setup before creating a gas executor, profile, runtime or authority', async () => {
    const before = await settings(), executor = vi.spyOn(runtime, 'cowExecutor');
    feasibility.guard.mockRejectedValue(new AuthorityError('wallet_authority_feasibility_blocked'));
    await expect(prepareCowSetup(owner, 1)).rejects.toThrow('wallet_authority_feasibility_blocked');
    expect(feasibility.guard).toHaveBeenCalledWith(owner, 1); expect(executor).not.toHaveBeenCalled();
    expect(await settings()).toEqual(before); expect(await loadStrategyProfile({ query })).toBeNull();
    expect(await loadAuthority({ query })).toBeNull(); expect(await runtime.loadCowRuntime({ query })).toBeNull();
    expect(walletExecutionSource()).toBeNull();
  });
  it('retains a prior grant reader and its unresolved nonce gate without restoring its write authority', async () => {
    const current = await seeded(), old = runtime.parseCowRuntime({ ...current, terms: { ...current.terms, id: randomUUID() } });
    const draft = createCowPolicyDraft(old.terms, { manager: old.manager, enforcer: old.enforcer }), id = randomUUID();
    await put(cowRuntimeArchiveKey(old), old);
    await put(`wallet:cow:v1:${draft.delegationHash.toLowerCase()}:order:${id}`, { version: 1, bindingId: draft.delegationHash.toLowerCase(),
      clientOrderId: id, uid: '0x' + 'a'.repeat(112), neverSubmitted: { at: NOW, nonceReleased: false } });
    const before = await settings(), source = await ensureCowWalletSource();
    expect(await source!.entryBlocker!()).toBe('cow_nonce_gap_requires_clearance');
    expect(await source!.verifyGrant!(source!.binding!)).toBe(false);
    expect(await settings()).toEqual(before);
  });
  it('keeps an unconfigured cold start empty without creating keys, profiles, permissions, entries or remote requests', async () => {
    const before = await settings(); expect(await ensureCowWalletSource()).toBeNull(); expect(walletExecutionSource()).toBeNull();
    expect(await settings()).toEqual(before); expect(await runtime.cowExecutor()).toBeNull(); expect(await settings()).toEqual(before);
  });
  it('constructs a read-only source from a verified-shaped profile without RPC, an executor key, a grant or implicit arming', async () => {
    await seeded(); const before = await settings();
    const [first, second] = await Promise.all([ensureCowWalletSource(), ensureCowWalletSource()]);
    expect(first).toBeTruthy(); expect(first).toBe(second); expect(walletExecutionSource()).toBe(first);
    expect(await first!.verifyGrant!(first!.binding!)).toBe(false); expect(await settings()).toEqual(before);
    expect(await query('SELECT key FROM app_settings WHERE key LIKE $1', ['wallet:strategy:cow-executor:%'])).toMatchObject({ rows: [] });
    expect(await loadAuthority({ query })).toBeNull();
  });
  it.each(['quote-decimals', 'authority-lifetime', 'authority-contracts', 'conversion', 'implementation'] as const)(
    'rejects persisted %s mismatch even with an unchanged revision', async change => {
      const c = await seeded(), p = profile(c);
      if (change === 'quote-decimals') p.quoteDecimals = 18;
      if (change === 'authority-lifetime') p.authority.expiresAt -= 30;
      if (change === 'authority-contracts') p.authority.scope.contracts.push(getAddress('0x' + '8'.repeat(40)));
      if (change === 'conversion') (p.conversion as { quoteUnit: string }).quoteUnit = 'FAKE-USDC';
      if (change === 'implementation') p.implementation.version = 'unreviewed-v2';
      await put('wallet:strategy:profile:v1', { storageVersion: 1, revision: 1, profile: p });
      const before = await settings(); await expect(ensureCowWalletSource()).rejects.toThrow('wallet_cow_runtime_invalid');
      expect(walletExecutionSource()).toBeNull(); expect(await settings()).toEqual(before);
    });
  it('does not retain a writable grant when a cached source observes a changed profile revision', async () => {
    const c = await seeded(), source = await ensureCowWalletSource(); expect(source).toBeTruthy();
    await saveStrategyProfile({ query }, profile(c), 1, NOW);
    await expect(ensureCowWalletSource()).rejects.toThrow('wallet_cow_runtime_invalid');
    expect(await source!.verifyGrant!(source!.binding!)).toBe(false);
  });
  it('rejects a mismatched persisted executor rather than creating or substituting a new key', async () => {
    await seeded(); await put(signerKey, encryptSecret(generatePrivateKey(), signerKey)); const before = await settings();
    await expect(ensureCowWalletSource()).rejects.toThrow('wallet_executor_unavailable');
    expect(await settings()).toEqual(before); expect(walletExecutionSource()).toBeNull();
  });
  it('restores a private persisted grant without arming and rechecks current signer identity before any grant readiness', async () => {
    const c = await seeded(), review = reviewFor(c), signature = await ownerAccount.signTypedData(review.delegation.typed);
    await saveAuthority({ query }, { state: 'verified', review, close: null, verifiedAt: NOW, updatedAt: NOW,
      signatureCiphertext: sealAuthoritySignature(review, signature) }, null);
    await put(signerKey, encryptSecret(executorKey, signerKey));
    vi.spyOn(authorityEnvironment, 'createAuthorityEnvironment').mockReturnValue({
      prepare: async () => { throw new Error('not called'); },
      verify: async (_r: AuthorityReview, at: number) => authorityVerification(at),
      prepareClose: async () => { throw new Error('not called'); }, verifyClose: async () => { throw new Error('not called'); },
    });
    const before = await settings(), source = await ensureCowWalletSource(); expect(source).toBeTruthy();
    expect(await source!.verifyGrant!(source!.binding!)).toBe(true);
    expect(await settings()).toEqual(before); // In particular entries/execution remain false.
    await query('DELETE FROM app_settings WHERE key=$1', [signerKey]);
    expect(await source!.verifyGrant!(source!.binding!)).toBe(false);
    expect((await query('SELECT key FROM app_settings WHERE key=$1', [signerKey])).rows).toEqual([]);
    await put(signerKey, encryptSecret(generatePrivateKey(), signerKey));
    expect(await source!.verifyGrant!(source!.binding!)).toBe(false);
  });
});
/** Real factory + persistent DAL + real submit HTTP boundary. The isolated
 * verifier represents external chain proof; no transaction/RPC is performed. */
async function publicationFixture(side: 'buy' | 'sell' = 'buy') {
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  const c = await seeded(), review = reviewFor(c), signature = await ownerAccount.signTypedData(review.delegation.typed);
  await saveAuthority({ query }, { state: 'verified', review, close: null, verifiedAt: NOW, updatedAt: NOW,
    signatureCiphertext: sealAuthoritySignature(review, signature) }, null);
  await put(signerKey, encryptSecret(executorKey, signerKey));
  await query("UPDATE app_settings SET value=value || '{\"entriesEnabled\":true,\"executionArmed\":true}'::jsonb WHERE key=$1", [stateKey]);
  const verify = vi.fn(async (_review: AuthorityReview, at: number) => authorityVerification(at));
  vi.spyOn(authorityEnvironment, 'createAuthorityEnvironment').mockReturnValue({
    prepare: async () => { throw new Error('Unexpected isolated preparation'); }, verify,
    prepareClose: async () => { throw new Error('Unexpected isolated closure'); },
    verifyClose: async () => { throw new Error('Unexpected isolated closure'); },
  });
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe('https://api.cow.fi/mainnet/api/v1/orders');
    expect(init?.method).toBe('POST'); expect(init?.redirect).toBe('error'); expect(init?.credentials).toBe('omit');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ from: owner, receiver: owner, signingScheme: 'presign', signature: '0x', fullBalanceCheck: true });
    return new Response(JSON.stringify(record.uid), { status: 201, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetcher);
  await ensureCowWalletSource();
  expect(constructed.executions).toHaveLength(1);
  const options = constructed.executions[0] as CowExecutionOptions;
  expect(options.api).toBeInstanceOf(CowSubmitApi);
  const key = 'a'.repeat(64), appData = cowPolicyOrderAppData(options.authority.draft, ('0x' + key) as Hex);
  const order: CowOrder = { sellToken: side === 'buy' ? c.terms.quoteToken : c.terms.markets[0].baseToken,
    buyToken: side === 'buy' ? c.terms.markets[0].baseToken : c.terms.quoteToken, receiver: owner,
    sellAmount: side === 'buy' ? '1000000' : '1000000000000000000', buyAmount: side === 'buy' ? '1000000000000000000' : '1000000',
    validTo: NOW + 300, appData: appData.hash, feeAmount: '0', kind: side, partiallyFillable: true,
    sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' };
  const intent: Intent = side === 'buy' ? { side, symbol: 'WETH-EUR', key, signal: signal('WETH-EUR', side, NOW), type: 'limit',
    quantity: '1', limitPrice: '1', budgetEur: '1', allocation: CONFIG.allocation, allocationReason: 'isolated-publication',
    estimatedCostEur: '0.001', estimatedCostFraction: '0.001', expectedEntryFeeEur: '0', expiresAt: NOW + 60,
    stopFraction: CONFIG.stopFraction, targetFraction: CONFIG.targetFraction,
    quote: { symbol: 'WETH-EUR', bid: '1', ask: '1', sourceAt: NOW, readAt: NOW, source: 'isolated-publication' } }
    : { side, symbol: 'WETH-EUR', key, quantity: '1', positionId: 'isolated-managed-position', reason: 'stop',
      signal: null, reduceOnly: true, protectionIds: [] };
  const record: CowOrderRecord = { version: 1, revision: 1, bindingId: options.authority.draft.delegationHash,
    clientOrderId: randomUUID(), decisionKey: key, owner, intent, uid: cowOrderUid(order, owner), order,
    fullAppData: appData.full, conversion: { currency: 'USDC', eurPerUnit: '1', sourceAt: NOW, sourceId: 'isolated-publication-fx' },
    createdAt: NOW, createdBlock: '1', cancelAt: side === 'buy' ? NOW + 60 : null,
    postState: 'not-posted', cancelRequested: false, lastError: null };
  return { c, record, options, verify, fetcher };
}

describe('production publication guard composition at the real HTTP sink', () => {
  it('constructs a real submit API and checks the fresh guard again before its sole POST', async () => {
    const f = await publicationFixture();
    const before = await settings();
    await f.options.authorizePublish!(f.record);
    expect(f.verify).toHaveBeenCalledOnce(); expect(f.fetcher).not.toHaveBeenCalled();
    expectedFetchCalls = 1;
    expect(await f.options.api.post(f.record)).toBe('accepted');
    expect(f.verify).toHaveBeenCalledTimes(2); expect(f.fetcher).toHaveBeenCalledOnce();
    expect(await settings()).toEqual(before);
  });
  it.each(['revoked', 'closing', 'paused', 'disarmed', 'deadline', 'validity', 'grant-expired', 'profile-changed', 'signer-removed'] as const)(
    'blocks %s changed after the first checkpoint before any HTTP POST', async change => {
      const f = await publicationFixture();
      await f.options.authorizePublish!(f.record);
      if (change === 'revoked') f.verify.mockImplementation(async (_review, at) => ({ ...authorityVerification(at), delegationEnabled: false }));
      if (change === 'closing') {
        const current = (await loadAuthority({ query }))!;
        await saveAuthority({ query }, { ...current, state: 'closing', updatedAt: NOW }, current.revision);
      }
      if (change === 'paused' || change === 'disarmed') await query('UPDATE app_settings SET value=jsonb_set(value,$2,$3::jsonb) WHERE key=$1',
        [stateKey, [change === 'paused' ? 'entriesEnabled' : 'executionArmed'], 'false']);
      if (change === 'deadline') vi.spyOn(Date, 'now').mockReturnValue((NOW + 60) * 1000);
      if (change === 'validity') { f.record.order.validTo = NOW + 59; f.record.uid = cowOrderUid(f.record.order, owner); }
      if (change === 'grant-expired') vi.spyOn(Date, 'now').mockReturnValue(f.c.terms.expiresAt * 1000);
      if (change === 'profile-changed') await saveStrategyProfile({ query }, profile(f.c), 1, NOW);
      if (change === 'signer-removed') await query('DELETE FROM app_settings WHERE key=$1', [signerKey]);
      await expect(f.options.api.post(f.record)).rejects.toThrow();
      expect(f.fetcher).not.toHaveBeenCalled();
    });
  it('observes closing persisted while the second chain verification is still in flight', async () => {
    const f = await publicationFixture();
    await f.options.authorizePublish!(f.record);
    let entered!: () => void, resume!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { resume = resolve; });
    f.verify.mockImplementationOnce(async (_review, at) => { entered(); await pending; return authorityVerification(at); });
    const posting = f.options.api.post(f.record);
    await started;
    const current = (await loadAuthority({ query }))!;
    await saveAuthority({ query }, { ...current, state: 'closing', updatedAt: NOW }, current.revision);
    resume();
    await expect(posting).rejects.toThrow('cow_authority_unavailable');
    expect(f.fetcher).not.toHaveBeenCalled(); expect((await loadAuthority({ query }))!.state).toBe('closing');
  });
  it('reads the deadline clock after awaited chain verification', async () => {
    const f = await publicationFixture(); f.record.cancelAt = NOW + 1;
    await f.options.authorizePublish!(f.record);
    f.verify.mockImplementationOnce(async (_review, at) => {
      vi.spyOn(Date, 'now').mockReturnValue((NOW + 1) * 1000); return authorityVerification(at);
    });
    await expect(f.options.api.post(f.record)).rejects.toThrow('cow_publication_fenced');
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(['binding', 'owner'] as const)('rejects a different record %s at the HTTP sink', async change => {
    const f = await publicationFixture();
    if (change === 'binding') f.record.bindingId = '0x' + 'f'.repeat(64);
    else { f.record.owner = getAddress('0x' + '9'.repeat(40)); f.record.order.receiver = f.record.owner;
      f.record.uid = cowOrderUid(f.record.order, f.record.owner); }
    await expect(f.options.api.post(f.record)).rejects.toThrow('cow_order_identity_invalid');
    expect(f.verify).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('keeps a valid managed sell publishable while new entries are paused', async () => {
    const f = await publicationFixture('sell');
    await query("UPDATE app_settings SET value=jsonb_set(value,'{entriesEnabled}','false'::jsonb) WHERE key=$1", [stateKey]);
    await f.options.authorizePublish!(f.record);
    expectedFetchCalls = 1;
    expect(await f.options.api.post(f.record)).toBe('accepted');
    expect(f.verify).toHaveBeenCalledTimes(2); expect(f.fetcher).toHaveBeenCalledOnce();
  });
});

describe('explicit setup scope and owner boundary', () => {
  it('rejects anonymous, scheduler-only, foreign-origin and invalid-CSRF setup before key creation or financial reads', async () => {
    const url = origin + '/api/wallet/strategy/setup', input = JSON.stringify({ action: 'prepare', owner, chainId: 1 });
    for (const authorization of ['', 'Bearer isolated-scheduler-never-owner']) {
      const response = await setupPOST(new Request(url, { method: 'POST', headers: { origin, 'content-type': 'application/json', authorization }, body: input }));
      expect(response.status).toBe(401);
    }
    const csrf = issueLoginCsrf(), logged = await login(password, new Request(origin + '/api/auth/login', { method: 'POST', headers: {
      origin, cookie: csrf.cookie.split(';')[0], 'x-csrf-token': csrf.csrfToken,
    } }));
    for (const extra of [{ origin: 'https://attacker.invalid', 'x-csrf-token': logged.csrfToken }, { origin, 'x-csrf-token': 'invalid' }]) {
      const response = await setupPOST(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `${sessionCookieName()}=${logged.sessionToken}`, ...extra }, body: input }));
      expect(response.status).toBe(403);
    }
    expect((await query('SELECT key FROM app_settings')).rows).toEqual([]); expect(walletExecutionSource()).toBeNull();
  });
  it('refreshes an unused unsigned CREATE address after nonce advance while leaving strategy switches and old review untouched', async () => {
    const c = await seeded();
    const review = createAuthorityReview({ id: randomUUID(), profileRevision: 1, now: NOW, preparation: {
      terms: c.terms, contracts: { manager: c.manager, implementation: c.implementation, enforcer: c.enforcer,
        settlement: COW_SETTLEMENT, vaultRelayer: COW_VAULT_RELAYER, release: 'test-v1', codeHashes: { manager: manifest.codeHashes.manager as Hex,
          implementation: manifest.codeHashes.implementation as Hex, settlement: manifest.codeHashes.settlement as Hex,
          vaultRelayer: manifest.codeHashes.vaultRelayer as Hex, enforcer: keccak256(expectedCowEnforcerRuntime(c.manager)) } },
      block: { number: '1', hash: ('0x' + 'a'.repeat(64)) as Hex, timestamp: NOW }, ownerMode: 'eoa',
      allowances: [ { token: c.terms.quoteToken, current: '0', finiteAmount: c.terms.maxQuoteTotal },
        { token: c.terms.markets[0].baseToken, current: '0', finiteAmount: c.terms.markets[0].maxBaseTotal } ], blockers: [] } });
    const saved = await saveAuthority({ query }, { state: 'draft', review, close: null, verifiedAt: null, signatureCiphertext: null, updatedAt: NOW }, null);
    const beforeState = (await query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [stateKey])).rows[0].value;
    const rpc = { getCode: vi.fn(async () => '0x'), getTransactionCount: vi.fn(async () => 1) };
    vi.spyOn(runtime, 'productionCowClient').mockReturnValue(rpc as unknown as ReturnType<typeof runtime.productionCowClient>);
    expect(await prepareCowSetup(owner, 1)).toMatchObject({ status: 'configured', profileRevision: 2 });
    const next = (await runtime.loadCowRuntime())!;
    expect(next.enforcer).toBe(getContractAddress({ from: owner, nonce: 1n })); expect(next.terms).toEqual(c.terms);
    expect(await loadAuthority({ query })).toEqual(saved);
    expect((await query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [stateKey])).rows[0].value).toEqual(beforeState);
    expect((await query('SELECT key FROM app_settings WHERE key LIKE $1', ['wallet:strategy:cow-executor:%'])).rows).toEqual([]);
  });
  it('refuses to rewrite an unsigned deployment once a transaction or batch reference exists', async () => {
    const c = await seeded(), p = (await loadStrategyProfile({ query }, NOW))!;
    const review = createAuthorityReview({ id: randomUUID(), profileRevision: p.revision, now: NOW, preparation: {
      terms: c.terms, contracts: { manager: c.manager, implementation: c.implementation, enforcer: c.enforcer,
        settlement: COW_SETTLEMENT, vaultRelayer: COW_VAULT_RELAYER, release: 'test-v1', codeHashes: { manager: manifest.codeHashes.manager as Hex,
          implementation: manifest.codeHashes.implementation as Hex, settlement: manifest.codeHashes.settlement as Hex,
          vaultRelayer: manifest.codeHashes.vaultRelayer as Hex, enforcer: keccak256(expectedCowEnforcerRuntime(c.manager)) } },
      block: { number: '1', hash: ('0x' + 'a'.repeat(64)) as Hex, timestamp: NOW }, ownerMode: 'eoa',
      allowances: [ { token: c.terms.quoteToken, current: '0', finiteAmount: c.terms.maxQuoteTotal },
        { token: c.terms.markets[0].baseToken, current: '0', finiteAmount: c.terms.markets[0].maxBaseTotal } ], blockers: [] } });
    await saveAuthority({ query }, { state: 'owner-actions-pending', review, close: null, verifiedAt: null, signatureCiphertext: null, updatedAt: NOW,
      candidateCallBatchIds: ['0x1234'] }, null);
    vi.spyOn(runtime, 'productionCowClient').mockReturnValue({ getCode: async () => '0x', getTransactionCount: async () => 1 } as unknown as ReturnType<typeof runtime.productionCowClient>);
    const before = await settings(); await expect(prepareCowSetup(owner, 1)).rejects.toThrow('wallet_authority_deploy_nonce_changed');
    expect(await settings()).toEqual(before);
  });
});

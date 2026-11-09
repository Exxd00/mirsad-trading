import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { EIP7702StatelessDeleGator } from '@metamask/delegation-abis';
import { encodeAbiParameters, encodeFunctionData, erc20Abi, getContractAddress, keccak256, parseAbiParameters,
  type Address, type Hex, type PublicClient } from 'viem';
import type { SqlExecutor } from '../src/lib/db';
import { CONFIG } from '../src/lib/execution/v1/model';
import { createAuthorityCloseReview, createAuthorityReview, verificationReady } from '../src/lib/wallet/authority';
import { createAuthorityEnvironment, loadAuthoritySetupFeeEvidence } from '../src/lib/wallet/authority-environment';
import { COW_DOMAIN, COW_SETTLEMENT, COW_VAULT_RELAYER, cowOrderUid, type CowOrder } from '../src/lib/wallet/cow-order';
import { expectedCowEnforcerRuntime } from '../src/lib/wallet/cow-artifact';
import { loadStrategyProfile, saveStrategyProfile } from '../src/lib/wallet/strategy-profile';
import { COW_PROFILE_CONVERSION, type CowRuntimeConfig } from '../src/lib/wallet/cow-runtime-config';
import { address, authorityPreparation, authorityProfile, hash, NOW, owner } from './fixtures/wallet-authority';

let db: PGlite, sql: SqlExecutor;
const execute = (tx: Pick<PGlite, 'query'>): SqlExecutor => ({ query: async <T>(q: string, p?: unknown[]) => {
  const r = await tx.query<T>(q, p); return { rows: r.rows, rowCount: Math.max(r.affectedRows ?? 0, r.rows.length) };
} });
beforeAll(async () => {
  db = new PGlite(); await db.exec('CREATE TABLE app_settings(key TEXT PRIMARY KEY,value JSONB NOT NULL,updated_at TIMESTAMPTZ DEFAULT NOW()); CREATE TABLE audit_events(event TEXT,detail JSONB)'); sql = execute(db);
});
beforeEach(async () => { await db.exec('TRUNCATE app_settings,audit_events'); });
afterAll(async () => { await db.close(); });
async function fixture() {
  const p = authorityPreparation(), profile = authorityProfile(), enforcer = getContractAddress({ from: owner.address, nonce: 0n });
  profile.authority.scope.contracts = [p.contracts.manager, enforcer, COW_SETTLEMENT, COW_VAULT_RELAYER];
  profile.conversion = { ...COW_PROFILE_CONVERSION }; profile.implementation.version = 'cow-wallet-v1';
  await saveStrategyProfile(sql, profile, null, NOW);
  const r = { version: 1, profileRevision: 1, terms: p.terms, createdAt: NOW, manager: p.contracts.manager, implementation: p.contracts.implementation,
    enforcer, executorAddress: p.terms.executor, mappings: [{ symbol: 'AAA-EUR', tokenAddress: address('4'), tokenDecimals: 18 }],
    tokenCodeHashes: { [address('3').toLowerCase()]: keccak256('0x6001'), [address('4').toLowerCase()]: keccak256('0x6001') },
    gasLimits: { maxGas: '1000000', maxFeePerGasWei: '100', maxPriorityFeePerGasWei: '1', maxTransactionCostWei: '100000000' } } as CowRuntimeConfig;
  const manifest = { release: 'isolated-v1', contracts: { manager: r.manager, implementation: r.implementation, settlement: COW_SETTLEMENT, vaultRelayer: COW_VAULT_RELAYER },
    codeHashes: { manager: keccak256('0x6000'), implementation: keccak256('0x6000'), settlement: keccak256('0x6000'), vaultRelayer: keccak256('0x6000'),
      quoteToken: keccak256('0x6001'), weth9: keccak256('0x6001') } };
  const state = { upgraded: true, deployed: true, nonce: 0, disabled: false, paused: false, reenabledLatest: false, badGetter: false,
    code: new Map<string, Hex>(), allowances: new Map<string, bigint>([[address('3').toLowerCase(), 100n], [address('4').toLowerCase(), 100n]]),
    filled: new Map<string, bigint>(), tx: null as Record<string, unknown> | null, receipt: null as Record<string, unknown> | null };
  const finalHash = ('0x' + 'b'.repeat(64)) as Hex;
  const client = {
    getChainId: vi.fn(async () => 1),
    getBlock: vi.fn(async (args: { blockTag?: string; blockNumber?: bigint }) => {
      const finalized = args.blockTag === 'finalized' || args.blockNumber === 100n;
      return { number: finalized ? 100n : 101n, hash: finalized ? finalHash : hash, timestamp: BigInt(finalized ? NOW - 800 : NOW) };
    }),
    getCode: vi.fn(async ({ address: a }: { address: Address }) => {
      if (state.code.has(a.toLowerCase())) return state.code.get(a.toLowerCase());
      if (a.toLowerCase() === owner.address.toLowerCase()) return state.upgraded ? ('0xef0100' + r.implementation.slice(2)) as Hex : '0x';
      if (a.toLowerCase() === r.enforcer.toLowerCase()) return state.deployed ? expectedCowEnforcerRuntime(r.manager) : '0x';
      return r.tokenCodeHashes[a.toLowerCase()] ? '0x6001' : '0x6000';
    }),
    readContract: vi.fn(async ({ address: a, functionName: name, args, blockNumber }: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
      if (name === 'allowance') return state.reenabledLatest && blockNumber === 101n ? 100n : state.allowances.get(a.toLowerCase()) ?? 0n;
      if (name === 'delegationManager') return state.badGetter ? address('9') : r.manager;
      if (name === 'settlement') return COW_SETTLEMENT;
      if (name === 'chainId') return 1n;
      if (name === 'disabledDelegations') return state.reenabledLatest && blockNumber === 101n ? false : state.disabled;
      if (name === 'paused') return state.paused;
      if (name === 'NAME') return 'DelegationManager';
      if (name === 'DOMAIN_VERSION') return '1';
      // Independent chain1 GPv2 domain, checked against ABI type/name/version hashes.
      if (name === 'domainSeparator') return '0xc078f884a2676e1345748b1feace7b0abee5d00ecadb6e574dcdd109a63e8943';
      if (name === 'vaultRelayer') return COW_VAULT_RELAYER;
      if (name === 'filledAmount') return state.filled.get(String(args?.[0]).toLowerCase()) ?? 0n;
      throw new Error('unexpected isolated method');
    }),
    getTransactionCount: vi.fn(async () => state.nonce), estimateGas: vi.fn(async () => 100000n),
    getBalance: vi.fn(async () => 10n ** 18n), estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })),
    getTransaction: vi.fn(async () => state.tx), getTransactionReceipt: vi.fn(async () => state.receipt),
  };
  const env = createAuthorityEnvironment({ client: client as unknown as PublicClient, query: sql.query,
    transaction: fn => db.transaction(tx => fn(execute(tx))), loadRuntime: async () => r, manifest });
  const loaded = (await loadStrategyProfile(sql, NOW))!;
  const review = () => env.prepare(loaded, NOW).then(preparation => createAuthorityReview({ id: crypto.randomUUID(), profileRevision: 1, preparation, now: NOW }));
  const transaction = (to: Address | null, input: Hex) => {
    state.tx = { hash, from: owner.address, to, input, value: 0n, nonce: 0, chainId: 1, blockHash: finalHash, blockNumber: 100n };
    state.receipt = { transactionHash: hash, from: owner.address, to, blockHash: finalHash, blockNumber: 100n,
      gasUsed: 21000n, effectiveGasPrice: 100n, status: 'success', contractAddress: null };
  };
  return { r, state, client, env, loaded, review, transaction };
}
describe('canonical production authority environment', () => {
  it('exposes a real unsigned pinned-nonce deployment step and refuses an advanced nonce', async () => {
    const f = await fixture(); f.state.deployed = false; f.state.upgraded = false;
    const p = await f.env.prepare(f.loaded, NOW);
    expect(p.deploymentStep).toMatchObject({ sender: owner.address, chainId: 1, expectedAddress: f.r.enforcer,
      transaction: { nonce: '0x0', value: '0x0' }, gasEstimate: '100000', blocker: null });
    expect(p.blockers).toContain('wallet_authority_enforcer_code_mismatch');
    expect(p.ownerMode).toBe('eoa'); expect(p.contracts.codeHashes.enforcer).toBe(keccak256(expectedCowEnforcerRuntime(f.r.manager)));
    f.state.nonce = 1;
    const changed = await f.env.prepare(f.loaded, NOW); expect(changed.deploymentStep).toBeNull();
    expect(changed.blockers).toContain('wallet_authority_deploy_nonce_changed');
  });
  it('requires exact code and public getters, current owner 7702 identity and current profile', async () => {
    const f = await fixture(), review = await f.review();
    expect(verificationReady(await f.env.verify(review, NOW), NOW)).toBe(true);
    f.state.badGetter = true; expect((await f.env.verify(review, NOW)).enforcerCode).toBe(false); f.state.badGetter = false;
    f.state.code.set(f.r.enforcer.toLowerCase(), '0x6000'); expect((await f.env.verify(review, NOW)).enforcerCode).toBe(false);
    f.state.code.clear(); f.state.upgraded = false; expect((await f.env.verify(review, NOW)).ownerImplementation).toBe(false);
    f.state.upgraded = true; f.r.profileRevision = 2; expect((await f.env.verify(review, NOW)).profileCurrent).toBe(false);
  });
  it('separates initial finite approvals from consumed runtime allowance and never accepts unlimited allowance', async () => {
    const f = await fixture(), review = await f.review(); f.state.allowances.set(address('3').toLowerCase(), 25n);
    expect((await f.env.verify(review, NOW, { transactionHashes: [], mode: 'initial' })).allowances).toBe(false);
    expect((await f.env.verify(review, NOW, { transactionHashes: [], mode: 'runtime' })).allowances).toBe(true);
    f.state.allowances.set(address('3').toLowerCase(), 0n);
    expect((await f.env.verify(review, NOW, { transactionHashes: [], mode: 'runtime' })).allowances).toBe(true);
    f.state.allowances.set(address('3').toLowerCase(), (1n << 256n) - 1n);
    expect((await f.env.verify(review, NOW, { transactionHashes: [], mode: 'runtime' })).allowances).toBe(false);
    f.state.paused = true;
    expect(await f.env.verify(review, NOW)).toMatchObject({ delegationEnabled: true, blockers: ['wallet_authority_manager_paused'] });
  });
  it('records only canonical finalized owner-paid gas for exact approved calls', async () => {
    const f = await fixture(), review = await f.review();
    const input = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [COW_VAULT_RELAYER, 100n] });
    f.transaction(address('3'), input);
    expect(verificationReady(await f.env.verify(review, NOW, { transactionHashes: [hash] }), NOW)).toBe(true);
    expect(await loadAuthoritySetupFeeEvidence(sql, owner.address)).toMatchObject([{ purpose: 'setup', transactionHash: hash, actualGasWei: '2100000', gasUsed: '21000' }]);
    f.state.receipt!.from = address('8');
    await expect(f.env.verify(review, NOW, { transactionHashes: [hash] })).rejects.toThrow('wallet_authority_receipt_unfinalized_or_invalid');
    f.state.receipt!.from = owner.address; f.state.receipt!.blockNumber = 101n;
    await expect(f.env.verify(review, NOW, { transactionHashes: [hash] })).rejects.toThrow('wallet_authority_receipt_unfinalized_or_invalid');
    f.state.receipt!.blockNumber = 100n; f.state.tx!.input = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [address('8'), 100n] });
    await expect(f.env.verify(review, NOW, { transactionHashes: [hash] })).rejects.toThrow('wallet_authority_receipt_invalid');
  });
  it('keeps RPC failures sanitized without manufactured verification or cost records', async () => {
    const f = await fixture(), review = await f.review(); f.client.getCode.mockRejectedValue(new Error('https://user:private-secret@rpc.invalid'));
    await expect(f.env.verify(review, NOW)).rejects.toThrow(/^wallet_authority_verification_unavailable$/);
    expect(await loadAuthoritySetupFeeEvidence(sql, owner.address)).toEqual([]);
  });
  it('durably fences entries and releases the lease even when a source write is still pending', async () => {
    const f = await fixture(), review = await f.review(), stateKey = `execution:v1:${CONFIG.accountId}:state`;
    await sql.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb),($3,$4::jsonb)', [stateKey, JSON.stringify({ entriesEnabled: true, executionArmed: true }),
      `execution:v1:${CONFIG.accountId}:write:submit:x`, JSON.stringify({ settledAt: null })]);
    await expect(f.env.prepareClose(review, NOW)).rejects.toThrow('wallet_authority_source_write_pending');
    expect((await sql.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [stateKey])).rows[0].value).toEqual({ entriesEnabled: false, executionArmed: true });
    expect((await sql.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [`execution:v1:${CONFIG.accountId}:lock`])).rows[0].value).toEqual({});
  });
  it('batches 129 standing UIDs while checking every tracked order and never treats expiry as invalidation', async () => {
    const f = await fixture(), review = await f.review();
    for (let i = 0; i < 129; i++) {
      const order: CowOrder = { sellToken: address('3'), buyToken: address('4'), receiver: owner.address, sellAmount: '100', buyAmount: '10', validTo: NOW - 2000 - i,
        appData: hash, feeAmount: '0', kind: 'buy', partiallyFillable: true, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' };
      const uid = cowOrderUid(order, owner.address);
      await sql.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)', [`wallet:cow:v1:${review.delegation.delegationHash.toLowerCase()}:order:${i}`,
        JSON.stringify({ version: 1, bindingId: review.delegation.delegationHash.toLowerCase(), owner: owner.address, uid, order })]);
    }
    const input = await f.env.prepareClose(review, NOW); expect(input.outstandingUids).toHaveLength(128); expect(input.remainingOrders).toBe(129);
    const close = createAuthorityCloseReview(review, input, NOW);
    f.state.disabled = true; f.state.allowances.set(address('3').toLowerCase(), 0n); f.state.allowances.set(address('4').toLowerCase(), 0n);
    expect((await f.env.verifyClose(review, close, NOW)).allTrackedOrdersTerminal).toBe(false);
    for (const uid of input.outstandingUids) f.state.filled.set(uid, (1n << 256n) - 1n);
    const last = await f.env.prepareClose(review, NOW); expect(last.outstandingUids).toHaveLength(1); expect(last.remainingOrders).toBe(1);
    f.state.filled.set(last.outstandingUids[0], (1n << 256n) - 1n);
    expect(await f.env.verifyClose(review, createAuthorityCloseReview(review, last, NOW), NOW)).toMatchObject({ delegationDisabled: true, allowancesZero: true, allTrackedOrdersTerminal: true, entriesFenced: true });
  });
  it('attributes canonical owner closing batch gas to closure and rejects mismatched live contract code', async () => {
    const f = await fixture(), review = await f.review(), close = createAuthorityCloseReview(review, await f.env.prepareClose(review, NOW), NOW);
    const data = encodeAbiParameters(parseAbiParameters('(address target,uint256 value,bytes callData)[]'), [close.calls.map(c => ({ target: c.to as Address, value: 0n, callData: c.data }))]);
    const input = encodeFunctionData({ abi: EIP7702StatelessDeleGator, functionName: 'execute', args: [('0x01' + '00'.repeat(31)) as Hex, data] });
    f.transaction(owner.address, input); f.state.disabled = true; f.state.allowances.set(address('3').toLowerCase(), 0n); f.state.allowances.set(address('4').toLowerCase(), 0n);
    expect((await f.env.verifyClose(review, close, NOW, { transactionHashes: [hash] })).receiptsVerified).toBe(true);
    expect(await loadAuthoritySetupFeeEvidence(sql, owner.address)).toMatchObject([{ purpose: 'closure', actualGasWei: '2100000' }]);
    f.state.reenabledLatest = true;
    expect(await f.env.verifyClose(review, close, NOW)).toMatchObject({ delegationDisabled: false, allowancesZero: false });
    f.state.reenabledLatest = false;
    f.state.code.set(COW_SETTLEMENT.toLowerCase(), '0x6002');
    await expect(f.env.verifyClose(review, close, NOW)).rejects.toThrow('wallet_authority_contract_identity_changed');
  });
});

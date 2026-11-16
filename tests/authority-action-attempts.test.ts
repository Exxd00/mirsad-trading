import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EIP7702StatelessDeleGator } from '@metamask/delegation-abis';
import { encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbiParameters, toHex, type Hex, type PublicClient } from 'viem';
import { closeDatabase, query } from '../src/lib/db';
import { AuthorityError, createAuthorityCloseReview, createAuthorityReview, type AuthorityPreparation } from '../src/lib/wallet/authority';
import { AUTHORITY_KEY, loadAuthority, saveAuthority } from '../src/lib/wallet/authority-store';
import { prepareAuthority, prepareAuthorityClose } from '../src/lib/wallet/authority-service';
import { prepareCowSetup } from '../src/lib/wallet/cow-setup';
import { cowNetwork } from '../src/lib/wallet/cow-network';
import { COW_SETTLEMENT, COW_VAULT_RELAYER } from '../src/lib/wallet/cow-order';
import { COW_ENFORCER_ARTIFACT, cowEnforcerDeployment, expectedCowEnforcerRuntime } from '../src/lib/wallet/cow-artifact';
import { cancelAuthorityActionUnsent, markAuthorityActionUnknown, readAuthorityActionFence, recordAuthorityActionReferences,
  rejectAuthorityAction, reserveAuthorityAction, resolveAuthorityAction, type AuthorityActionPhase } from '../src/lib/wallet/authority-action-attempts';
import { resolveAuthorityActionReceipt } from '../src/lib/wallet/authority-action-receipt';
import { loadAuthoritySetupFeeEvidence } from '../src/lib/wallet/authority-environment';
import { configuredGas, GAS_NOW } from './helpers/executor-gas';
import codes from './fixtures/cow-gnosis-runtime.json';
import { prepareExecutorGasReview } from '../src/lib/wallet/gnosis-executor-gas';
import { readExecutorGasFence, reserveExecutorGas, saveExecutorGasArtifact } from '../src/lib/wallet/gnosis-executor-gas-attempts';
import { parseAuthorityActionReservationUI, parseAuthorityActionStateUI } from '../src/lib/wallet/authority-action-ui';
const HASH = toHex(100n, { size: 32 }), TX = toHex(999n, { size: 32 }), TX2 = toHex(998n, { size: 32 });
beforeEach(async () => {
  await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('VERCEL', ''); vi.stubEnv('VERCEL_ENV', '');
  vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('base64')); vi.stubEnv('MIRSAD_RETIRE_LEGACY_CONNECTION', undefined);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(GAS_NOW * 1000);
});
afterEach(async () => { await closeDatabase(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function fixture(phase: AuthorityActionPhase = 'bootstrap') {
  const f = await configuredGas(), n = cowNetwork(100);
  const preparation: AuthorityPreparation = { terms: f.config.terms, contracts: { manager: f.config.manager, implementation: f.config.implementation,
    enforcer: f.config.enforcer, settlement: COW_SETTLEMENT, vaultRelayer: COW_VAULT_RELAYER, release: 'isolated-real-runtime', codeHashes: {
      manager: n.codeHashes.manager, implementation: n.codeHashes.implementation, settlement: n.codeHashes.settlement,
      vaultRelayer: n.codeHashes.vaultRelayer, enforcer: keccak256(expectedCowEnforcerRuntime(f.config.manager, 100)) } },
    block: { number: '100', hash: HASH, timestamp: GAS_NOW - 1 }, ownerMode: 'eoa', tokenCodeHashes: f.config.tokenCodeHashes,
    allowances: [{ token: f.config.terms.quoteToken, current: '0', finiteAmount: f.config.terms.maxQuoteTotal },
      { token: f.config.terms.markets[0].baseToken, current: '0', finiteAmount: f.config.terms.markets[0].maxBaseTotal }], blockers: [] };
  if (phase === 'deploy') preparation.deploymentStep = { compilerVersion: '0.8.30', artifactHash: COW_ENFORCER_ARTIFACT.artifactHash as Hex,
    expectedAddress: f.config.enforcer, sender: f.owner, chainId: 100, transaction: { data: cowEnforcerDeployment(f.config.manager, 100), nonce: '0x0', value: '0x0' },
    gasEstimate: '800000', blocker: null };
  const review = createAuthorityReview({ id: randomUUID(), profileRevision: 1, preparation, now: GAS_NOW });
  const close = phase === 'close' ? createAuthorityCloseReview(review, { block: preparation.block, outstandingUids: [], fenceReference: 'isolated-fence:1', blockers: [] }, GAS_NOW) : null;
  const record = await saveAuthority({ query }, { review, close, state: phase === 'close' ? 'closing' : 'draft', signatureCiphertext: null, verifiedAt: null, updatedAt: GAS_NOW }, null);
  let now = GAS_NOW;
  const deps = { clock: () => now, baseline: vi.fn(async () => ({ ownerPendingNonce: 0, sourceBlock: preparation.block })) };
  const input = { id: review.id, digest: review.digest, expectedRevision: record.revision, phase, ...(close ? { closeDigest: close.digest } : {}) };
  return { ...f, preparation, review, close, record, gasDeps: f.deps, deps, input, setTime: (t: number) => { now = t; vi.setSystemTime(t * 1000); } };
}
describe('durable authority prompts and cross-writer SQL fence', () => {
  it.each(['deploy', 'bootstrap', 'close'] as const)('reserves an immutable %s payload before a prompt without creating authority', async phase => {
    const f = await fixture(phase), r = await reserveAuthorityAction(f.input, f.deps);
    expect(await parseAuthorityActionReservationUI(r, f.review, phase, f.close ?? undefined, f.record.revision)).not.toBeNull();
    expect(r.attempt).toMatchObject({ accountId: 'metamask-strategy-v1', phase, owner: f.owner, chainId: 100, status: 'reserved', ownerPendingNonce: 0 });
    expect(await readAuthorityActionFence()).toMatchObject({ blocked: true, active: { id: r.attempt.id } });
    expect((await loadAuthority({ query }))?.signatureCiphertext).toBeNull();
    await expect(prepareCowSetup(f.owner, 100)).rejects.toThrow('wallet_authority_action_pending');
    await expect(prepareAuthority({ query }, null, f.record.revision, GAS_NOW)).rejects.toThrow('wallet_authority_action_pending');
    await expect(prepareAuthorityClose({ query }, null, { ...f.input }, GAS_NOW)).rejects.toThrow('wallet_authority_action_pending');
  });
  it.each(['gas-first', 'authority-first', 'concurrent'] as const)('uses one global SQL fence for cross-tab gas/authority %s reservation', async order => {
    const f = await fixture(), p = await prepareExecutorGasReview(f.owner, f.executor, f.gasDeps); await saveExecutorGasArtifact(p);
    expect(p.audit.status).toBe('reviewable');
    const input = { owner: f.owner, expectedExecutor: f.executor, reviewDigest: p.audit.review!.digest, proofDigest: p.audit.freshProof!.digest };
    const gas = () => reserveExecutorGas(input, f.gasDeps), authority = () => reserveAuthorityAction(f.input, f.deps);
    if (order === 'gas-first') { await gas(); await expect(authority()).rejects.toThrow('wallet_authority_executor_gas_pending'); }
    else if (order === 'authority-first') { await authority(); await expect(gas()).rejects.toThrow('wallet_authority_action_pending'); }
    else {
      const results = await Promise.allSettled([authority(), gas()]); expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    }
    const a = await readAuthorityActionFence(), g = await readExecutorGasFence(f.owner);
    expect(Number(a.blocked) + Number(g.blocked)).toBe(1); expect((await loadAuthority({ query }))?.signatureCiphertext).toBeNull();
    expect((await loadAuthoritySetupFeeEvidence({ query }, f.owner, 100))).toEqual([]);
  });
  it('serializes concurrent reservations and retains an unknown request beyond every review deadline and a new module instance', async () => {
    const f = await fixture(), results = await Promise.allSettled([reserveAuthorityAction(f.input, f.deps), reserveAuthorityAction(f.input, f.deps)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const r = (results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof reserveAuthorityAction>>>).value;
    await markAuthorityActionUnknown(r.attempt.id, r.attempt.snapshotDigest, f.deps); f.setTime(GAS_NOW + 864000);
    expect(await readAuthorityActionFence({ query })).toMatchObject({ blocked: true, active: { id: r.attempt.id, status: 'unknown' } });
    await expect(cancelAuthorityActionUnsent(r.attempt.id, r.attempt.snapshotDigest, false, f.deps)).rejects.toThrow('wallet_authority_action_changed');
  });
  it('fences a prepare which started provider I/O before the owner reserved the existing review', async () => {
    const f = await fixture(); let finish!: (v: AuthorityPreparation) => void;
    const env = { prepare: vi.fn(() => new Promise<AuthorityPreparation>(resolve => { finish = resolve; })) };
    const preparing = prepareAuthority({ query }, env as never, f.record.revision, GAS_NOW).catch(e => e as Error);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await reserveAuthorityAction(f.input, f.deps); finish(f.preparation);
    expect(await preparing).toMatchObject({ message: 'wallet_authority_action_pending' });
    expect((await loadAuthority({ query }))?.review.id).toBe(f.review.id);
  });
  it('rejects a setup changed during baseline I/O before persisting a reservation', async () => {
    const f = await fixture();
    await expect(reserveAuthorityAction(f.input, { ...f.deps, baseline: async () => {
      await query("UPDATE app_settings SET value=jsonb_set(value,'{revision}','2'::jsonb) WHERE key=$1", [AUTHORITY_KEY]);
      return f.deps.baseline();
    } })).rejects.toThrow('wallet_authority_revision_conflict');
    expect((await readAuthorityActionFence()).blocked).toBe(false);
  });
  it('durably records a late returned reference after expiry without current revision and keeps the fence on metadata retry', async () => {
    const f = await fixture(), r = await reserveAuthorityAction(f.input, f.deps); f.setTime(GAS_NOW + 1000);
    const input = { attemptId: r.attempt.id, snapshotDigest: r.attempt.snapshotDigest, callBatchIds: ['0x1234'] };
    const first = await recordAuthorityActionReferences(input, f.deps), revision = (await loadAuthority({ query }))!.revision;
    expect(parseAuthorityActionStateUI({ actionAttempt: first.attempt, actionFence: first.actionFence })).not.toBeNull();
    expect(first.actionFence.blocked).toBe(true); expect(first.attempt.callBatchIds).toEqual(['0x1234']);
    await recordAuthorityActionReferences(input, f.deps); expect((await loadAuthority({ query }))!.revision).toBe(revision);
    expect((await loadAuthority({ query }))?.state).toBe('owner-actions-pending');
    await expect(rejectAuthorityAction(r.attempt.id, r.attempt.snapshotDigest, 4001, f.deps)).rejects.toThrow('wallet_authority_action_changed');
  });
  it('releases only explicit code4001 or trusted pre-RPC unsent, never an arbitrary provider error', async () => {
    const f = await fixture(), r = await reserveAuthorityAction(f.input, f.deps);
    await expect(rejectAuthorityAction(r.attempt.id, r.attempt.snapshotDigest, -32000, f.deps)).rejects.toThrow('wallet_authority_action_invalid');
    expect((await cancelAuthorityActionUnsent(r.attempt.id, r.attempt.snapshotDigest, false, f.deps)).actionFence.blocked).toBe(false);
    const next = await reserveAuthorityAction(f.input, f.deps);
    expect((await rejectAuthorityAction(next.attempt.id, next.attempt.snapshotDigest, 4001, f.deps)).actionFence.blocked).toBe(false);
  });
  it('uses a fresh close deadline even when the original opening review has expired', async () => {
    const f = await fixture('close'); f.setTime(GAS_NOW + 700);
    const close = createAuthorityCloseReview(f.review, { ...f.close!, block: { ...f.preparation.block, timestamp: GAS_NOW + 700 } }, GAS_NOW + 700);
    const rec = await saveAuthority({ query }, { ...f.record, close, updatedAt: GAS_NOW + 700 }, f.record.revision);
    const r = await reserveAuthorityAction({ ...f.input, expectedRevision: rec.revision, closeDigest: close.digest }, { ...f.deps,
      baseline: async () => ({ ownerPendingNonce: 0, sourceBlock: { ...f.preparation.block, timestamp: GAS_NOW + 699 } }) });
    expect(r.attempt.expiresAt).toBe(close.reviewExpiresAt);
  });
  it('keeps every reference and the fence when another hash arrives while canonical proof is in flight', async () => {
    const f = await fixture(), r = await reserveAuthorityAction(f.input, f.deps);
    await recordAuthorityActionReferences({ attemptId: r.attempt.id, snapshotDigest: r.attempt.snapshotDigest, transactionHashes: [TX] }, f.deps);
    const resolve = vi.fn(async () => {
      await recordAuthorityActionReferences({ attemptId: r.attempt.id, snapshotDigest: r.attempt.snapshotDigest, transactionHashes: [TX2] }, f.deps);
      // Explicit resolver-port double for the old one-hash snapshot; actual
      // canonical transaction semantics are covered by the receipt suite.
      return { resolution: { outcome: 'confirmed' as const, transactionHashes: [TX], evidenceDigest: HASH, resolvedAt: GAS_NOW }, fees: [{
        version: 1 as const, chainId: 100 as const, owner: f.owner, transactionHash: TX, blockNumber: '100', blockHash: HASH, from: f.owner,
        to: f.owner, nonce: 0, inputHash: HASH, gasUsed: '100', effectiveGasPriceWei: '2', actualGasWei: '200', status: 'success' as const,
        verifiedAt: GAS_NOW, authorityDigest: r.review.digest, purpose: 'setup' as const }] };
    });
    await expect(resolveAuthorityAction(r.attempt.id, r.attempt.snapshotDigest, undefined, { ...f.deps, resolve })).rejects.toThrow('wallet_authority_action_changed');
    expect(await readAuthorityActionFence()).toMatchObject({ blocked: true, active: { transactionHashes: [TX, TX2], resolution: null } });
  });
  it.each(['confirmed', 'reverted'] as const)('runs actual receipt proof → SQL attempt → existing fee reader for %s without granting authority', async outcome => {
    const f = await fixture('deploy'), r = await reserveAuthorityAction(f.input, f.deps); f.setTime(GAS_NOW + 20);
    await recordAuthorityActionReferences({ attemptId: r.attempt.id, snapshotDigest: r.attempt.snapshotDigest, transactionHashes: [TX] }, f.deps);
    const h = (n: number) => ({ number: BigInt(n), hash: n === 100 ? HASH : toHex(BigInt(n), { size: 32 }), timestamp: BigInt(GAS_NOW + (n === 100 ? -1 : n - 100)) });
    const client = { getChainId: async () => 100, getBlock: async (v: { blockTag?: string; blockNumber?: bigint }) => h(v.blockTag === 'latest' ? 110 : v.blockTag === 'finalized' ? 105 : Number(v.blockNumber)),
      getTransaction: async () => ({ hash: TX, chainId: 100, from: f.owner, to: null, value: 0n, nonce: 0, input: r.payload.kind === 'transaction' ? r.payload.transaction.data : '0x', blockNumber: 102n, blockHash: h(102).hash }),
      getTransactionReceipt: async () => ({ transactionHash: TX, from: f.owner, to: null, status: outcome === 'confirmed' ? 'success' : 'reverted', blockNumber: 102n, blockHash: h(102).hash,
        gasUsed: 800000n, effectiveGasPrice: 20n, contractAddress: outcome === 'confirmed' ? f.config.enforcer : null }),
      getCode: async () => expectedCowEnforcerRuntime(f.config.manager, 100) } as unknown as PublicClient;
    const result = await resolveAuthorityAction(r.attempt.id, r.attempt.snapshotDigest, undefined, { ...f.deps,
      resolve: (value, refs) => resolveAuthorityActionReceipt(value, refs, { client, clock: f.deps.clock }) });
    expect(result).toMatchObject({ actionFence: { blocked: false }, attempt: { status: outcome, resolution: { outcome } } });
    expect(parseAuthorityActionStateUI({ actionAttempt: result.attempt, actionFence: result.actionFence })).not.toBeNull();
    expect((await loadAuthority({ query }))?.signatureCiphertext).toBeNull();
    expect((await loadAuthoritySetupFeeEvidence({ query }, f.owner, 100))[0].actualGasWei).toBe('16000000');
    expect((await loadAuthority({ query }))?.candidateTransactionHashes).toEqual(outcome === 'confirmed' ? [TX] : []);
  });
});

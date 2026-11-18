import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex } from 'viem';
import { closeDatabase, query, transaction } from '../src/lib/db';
import { CONFIG } from '../src/lib/execution/v1/model';
import { loadAuthoritySetupFeeEvidence } from '../src/lib/wallet/authority-environment';
import { prepareExecutorGasReview, verifyExecutorGasReview } from '../src/lib/wallet/gnosis-executor-gas';
import { cancelExecutorGasUnsent, markExecutorGasUnknown, readExecutorGasFence, recordExecutorGasHash, rejectExecutorGas,
  reserveExecutorGas, resolveExecutorGasAttempt, saveExecutorGasArtifact } from '../src/lib/wallet/gnosis-executor-gas-attempts';
import { parseExecutorGasAttemptResultUI, parseExecutorGasReservationUI, parseExecutorGasReviewUI } from '../src/lib/wallet/gnosis-executor-gas-ui';
import { configuredGas, GAS_NOW, GAS_OWNER, GAS_TX } from './helpers/executor-gas';
import { COW_RUNTIME_KEY } from '../src/lib/wallet/cow-runtime-config';
import { CowSetupFeasibilityError } from '../src/lib/wallet/cow-feasibility';
beforeEach(async () => {
  await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('VERCEL', ''); vi.stubEnv('VERCEL_ENV', '');
  vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('base64')); vi.stubEnv('MIRSAD_RETIRE_LEGACY_CONNECTION', undefined);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(GAS_NOW * 1000);
});
afterEach(async () => { await closeDatabase(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function prepared() {
  const f = await configuredGas(), p = await prepareExecutorGasReview(f.owner, f.executor, f.deps);
  expect(p.audit.status, p.audit.blockers.join(',')).toBe('reviewable'); await saveExecutorGasArtifact(p);
  const input = { owner: f.owner, expectedExecutor: f.executor, reviewDigest: p.audit.review!.digest, proofDigest: p.audit.freshProof!.digest };
  return { ...f, p, input };
}
const attempts = () => query<{ key: string; value: unknown }>("SELECT key,value FROM app_settings WHERE key LIKE 'wallet:gnosis:executor-gas:v1:%:attempt:%'");
describe('configured Gnosis executor gas owner review and durable prompt fence', () => {
  it('retries only a cost-only rejection or an expired quote and leaves the wallet untouched', async () => {
    const f = await configuredGas(), at = GAS_NOW * 1000;
    const checks = [
      { decision: 'blocked', blockers: ['wallet_sample_feasibility_unproven', 'wallet_sample_cost_ceiling_exceeded'], expiresAt: at + 1000, expected: 'wallet_executor_gas_cost_above_cap' },
      { decision: 'eligible-for-setup', blockers: [], expiresAt: at, expected: 'wallet_executor_gas_cost_expired' },
      { decision: 'unproven', blockers: ['wallet_sample_cost_stale'], expiresAt: at + 1000, expected: 'wallet_executor_gas_cost_expired' },
      { decision: 'blocked', blockers: ['wallet_owner_gas_unavailable', 'wallet_sample_cost_ceiling_exceeded'], expiresAt: at, expected: 'wallet_executor_gas_feasibility_blocked' },
      { decision: 'unproven', blockers: ['wallet_sample_quote_unavailable'], expiresAt: at + 1000, expected: 'wallet_executor_gas_feasibility_blocked' },
    ] as const;
    for (const check of checks) {
      const failure = new CowSetupFeasibilityError({ ...check, blockers: [...check.blockers] }, at);
      expect(failure.code).toBe('wallet_authority_feasibility_blocked');
      const { audit } = await prepareExecutorGasReview(f.owner, f.executor, { ...f.deps, feasibility: async () => { throw failure; } });
      expect(audit).toMatchObject({ status: 'blocked', review: null, freshProof: null, ownerReviewAllowed: false, blockers: [check.expected] });
    }
    expect((await attempts()).rowCount).toBe(0);
  });
  it('binds the actual encrypted executor and current profile while leaving all trading state unarmed and prices/authority unchanged', async () => {
    const f = await prepared(), review = f.p.audit.review!;
    expect(review).toMatchObject({ chainId: 100, owner: f.owner, executor: f.executor, profileRevision: 1,
      targetBalanceWei: '700000000000000', minimumRoundTripWei: '112000000000000', shortfallWei: '700000000000000',
      ownerCosts: 'runtime-fee-cap-review-budget-wallet-fees-and-other-setup-not-certified',
      transaction: { from: f.owner, to: f.executor, chainId: 100, data: '0x', value: toHex(700000000000000n) } });
    expect(parseExecutorGasReviewUI({ ...f.p.audit, ownerReviewAllowed: true, fence: { blocked: false, active: null, last: null } }, f.owner, f.executor)).not.toBeNull();
    expect((await query<{ value: { entriesEnabled: boolean; executionArmed?: boolean } }>('SELECT value FROM app_settings WHERE key=$1', [`execution:v1:${CONFIG.accountId}:state`])).rows[0].value).toMatchObject({ entriesEnabled: false });
    expect((await query("SELECT key FROM app_settings WHERE key='wallet:strategy:authority:v1' OR key LIKE '%:decision:%' OR key LIKE '%:order:%'")).rowCount).toBe(0);
    expect(f.deps.feasibility).toHaveBeenCalledWith(f.owner, 100);
  });
  it('cannot expose or create an executor before setup, or reserve a different recipient/owner/profile', async () => {
    const before = await query('SELECT key,value FROM app_settings');
    expect((await prepareExecutorGasReview(GAS_OWNER, '0x2222222222222222222222222222222222222222')).audit.status).toBe('blocked');
    expect((await query('SELECT key,value FROM app_settings')).rows).toEqual(before.rows);
    const f = await prepared();
    for (const [owner, executor] of [[f.owner, GAS_OWNER], ['0x3333333333333333333333333333333333333333', f.executor]])
      expect((await prepareExecutorGasReview(owner, executor, f.deps)).audit.status).toBe('blocked');
    await expect(reserveExecutorGas({ ...f.input, expectedExecutor: GAS_OWNER }, f.deps)).rejects.toThrow('wallet_executor_gas_review_changed');
    expect((await attempts()).rowCount).toBe(0);
  });
  it.each(['entries', 'pending-write', 'fees', 'history', 'runtime'])('blocks %s before permitting a wallet review', async fault => {
    const f = await configuredGas();
    if (fault === 'entries') await query("UPDATE app_settings SET value=jsonb_set(value,'{entriesEnabled}','true'::jsonb) WHERE key=$1", [`execution:v1:${CONFIG.accountId}:state`]);
    if (fault === 'pending-write') await query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)', [`execution:v1:${CONFIG.accountId}:write:unknown`, JSON.stringify({ settledAt: null })]);
    if (fault === 'fees') f.deps.feasibility.mockRejectedValueOnce(new Error('wallet_authority_feasibility_blocked'));
    if (fault === 'history') f.deps.historyEnd = async () => 0;
    if (fault === 'runtime') await query("UPDATE app_settings SET value=jsonb_set(value,'{profileRevision}','2'::jsonb) WHERE key=$1", [COW_RUNTIME_KEY]);
    const result = await prepareExecutorGasReview(f.owner, f.executor, f.deps);
    expect(result.audit).toMatchObject({ status: 'blocked', ownerReviewAllowed: false, executionApproved: false, freshProof: null });
    expect((await attempts()).rowCount).toBe(0);
  });
  it('serializes concurrent reserves under the financial lease and preserves an unknown fence beyond every expiry', async () => {
    const f = await prepared(), results = await Promise.allSettled([reserveExecutorGas(f.input, f.deps), reserveExecutorGas(f.input, f.deps)]);
    expect(results.filter(v => v.status === 'fulfilled')).toHaveLength(1);
    const r = (results.find(v => v.status === 'fulfilled')! as PromiseFulfilledResult<Awaited<ReturnType<typeof reserveExecutorGas>>>).value;
    expect(parseExecutorGasReservationUI(r, f.owner, f.executor)).not.toBeNull();
    await markExecutorGasUnknown(f.owner, r.attempt.id); f.setNow(GAS_NOW + 864000);
    expect(await readExecutorGasFence(f.owner)).toMatchObject({ blocked: true, active: { id: r.attempt.id, status: 'unknown', transactionHash: null } });
    expect((await attempts()).rowCount).toBe(1);
  });
  it('permits only explicit 4001 or unchanged pre-request owner attestation, never an unknown or already hashed request', async () => {
    const f = await prepared(), first = await reserveExecutorGas(f.input, f.deps);
    await expect(rejectExecutorGas(f.owner, first.attempt.id, -32000)).rejects.toThrow('wallet_executor_gas_request_invalid');
    expect((await rejectExecutorGas(f.owner, first.attempt.id, 4001)).fence.blocked).toBe(false);
    const next = await reserveExecutorGas(f.input, f.deps);
    expect((await cancelExecutorGasUnsent(f.owner, next.attempt.id, next.attempt.snapshotDigest, false, f.deps)).attempt.status).toBe('owner-cancelled-unsent');
    const pending = await reserveExecutorGas(f.input, f.deps); await markExecutorGasUnknown(f.owner, pending.attempt.id);
    await expect(cancelExecutorGasUnsent(f.owner, pending.attempt.id, pending.attempt.snapshotDigest, false, f.deps)).rejects.toThrow('wallet_executor_gas_attempt_changed');
    await recordExecutorGasHash(f.owner, pending.attempt.id, GAS_TX);
    await expect(rejectExecutorGas(f.owner, pending.attempt.id, 4001)).rejects.toThrow('wallet_executor_gas_attempt_changed');
    expect((await recordExecutorGasHash(f.owner, pending.attempt.id, GAS_TX)).attempt.transactionHash).toBe(GAS_TX);
  });
  it('rejects profile changes during awaited reads and proof expiry while waiting on SQL instead of saving a stale send candidate', async () => {
    const f = await prepared();
    await expect(reserveExecutorGas(f.input, { ...f.deps, verify: async (review, deps) => {
      const p = await verifyExecutorGasReview(review, deps);
      await query("UPDATE app_settings SET value=jsonb_set(value,'{profileRevision}','2'::jsonb) WHERE key=$1", [COW_RUNTIME_KEY]); return p;
    } })).rejects.toThrow('wallet_executor_gas_setup_changed');
    expect((await attempts()).rowCount).toBe(0);
  });
  it('requires a new review if the owner balance/retained budget changes, instead of reserving a snapshot the client would reject', async () => {
    const f = await prepared(); f.state.ownerBalance--;
    await expect(reserveExecutorGas(f.input, f.deps)).rejects.toThrow('wallet_executor_gas_review_changed');
    expect((await attempts()).rowCount).toBe(0);
    const next = await prepareExecutorGasReview(f.owner, f.executor, f.deps);
    expect(parseExecutorGasReviewUI({ ...next.audit, ownerReviewAllowed: true, fence: { blocked: false, active: null, last: null } }, f.owner, f.executor)).not.toBeNull();
  });
  it('rejects a proof that expires during the SQL wait without leaving an unsent reservation', async () => {
    const f = await prepared();
    await expect(reserveExecutorGas(f.input, { ...f.deps, transact: work => transaction(tx => {
      f.setNow(GAS_NOW + 16); return work(tx);
    }) })).rejects.toThrow('wallet_executor_gas_stale');
    expect((await attempts()).rowCount).toBe(0);
  });
  it.each(['confirmed', 'reverted'] as const)('resolves actual %s direct receipts through SQL and the client DTO, records only paid gas as expense', async outcome => {
    const f = await prepared(), r = await reserveExecutorGas(f.input, f.deps); await recordExecutorGasHash(f.owner, r.attempt.id, GAS_TX);
    f.setNow(GAS_NOW + 20); vi.setSystemTime((GAS_NOW + 20) * 1000); f.state.latest = 204n; f.state.finalized = 202n;
    f.state.receipt = { transactionHash: GAS_TX, blockNumber: '0xc9', blockHash: f.header(201n).hash, status: outcome === 'confirmed' ? '0x1' : '0x0',
      from: f.owner, to: f.executor, gasUsed: toHex(21000n), effectiveGasPrice: toHex(20000010n) };
    f.state.transaction = { hash: GAS_TX, chainId: '0x64', from: f.owner, to: f.executor, input: '0x', value: r.transaction.value,
      nonce: '0x0', blockNumber: '0xc9', blockHash: f.header(201n).hash };
    const result = await resolveExecutorGasAttempt(f.owner, r.attempt.id, f.deps);
    expect(result).toMatchObject({ attempt: { status: outcome, resolution: { valueWei: outcome === 'confirmed' ? '700000000000000' : '0' } }, fence: { blocked: false } });
    expect(parseExecutorGasAttemptResultUI(result, f.owner, f.executor)).not.toBeNull();
    const fee = await loadAuthoritySetupFeeEvidence({ query }, f.owner, 100);
    expect(fee).toHaveLength(1); expect(fee[0].actualGasWei).toBe((21000n * 20000010n).toString());
    expect(fee[0].actualGasWei).not.toBe('700000000000000');
  });
  it('keeps a missing-hash unknown reservation through an actual disk database restart', async () => {
    await closeDatabase(); const folder = await realpath(await mkdtemp(join(tmpdir(), 'mirsad-executor-gas-')));
    try {
      vi.stubEnv('LOCAL_DATABASE_PATH', folder); const f = await prepared(), r = await reserveExecutorGas(f.input, f.deps);
      await markExecutorGasUnknown(f.owner, r.attempt.id); await closeDatabase();
      expect(await readExecutorGasFence(f.owner)).toMatchObject({ blocked: true, active: { id: r.attempt.id, status: 'unknown', transactionHash: null } });
    } finally {
      await closeDatabase();
      if (dirname(folder) !== resolve(tmpdir()) || !basename(folder).startsWith('mirsad-executor-gas-')) throw new Error('Unexpected temporary directory');
      await rm(folder, { recursive: true, force: true });
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDatabase, query, transaction } from '../src/lib/db';
import { createSqlGnosisEurStateStore } from '../src/lib/wallet/gnosis-eur-state-store';
import { GNOSIS_REFERENCE_IDENTITY } from '../src/lib/wallet/gnosis-market';
import { prepareGnosisFundingReview, proveGnosisFundingNoSourceEffect, verifyGnosisFundingReview, type GnosisFundingPrepared } from '../src/lib/wallet/gnosis-funding-service';
import { attestGnosisFundingRejection, cancelGnosisFundingUnsent, markGnosisFundingUnknown, readGnosisFundingFence, recordGnosisFundingHash,
  reserveGnosisFundingAttempt, resolveGnosisFundingAttempt, saveGnosisFundingArtifact, type GnosisFundingResolution } from '../src/lib/wallet/gnosis-funding-attempts';
import { fundingReads, FUNDING_OWNER, FUNDING_NOW } from './helpers/gnosis-funding';
import { parseGnosisFundingReservationUI } from '../src/lib/wallet/gnosis-funding-ui';
const hash = ('0x' + '11'.repeat(32)) as `0x${string}`, otherHash = ('0x' + '22'.repeat(32)) as `0x${string}`;
const fenceKey = `wallet:gnosis:eur-state:v1:${GNOSIS_REFERENCE_IDENTITY}:quarantine`;
beforeEach(async () => { await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL', ''); vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); vi.stubEnv('MIRSAD_RETIRE_LEGACY_CONNECTION', undefined); });
afterEach(async () => { await closeDatabase(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function fixture() {
  const f = fundingReads(), store = createSqlGnosisEurStateStore({ clock: f.clock });
  for (const chunk of f.state.history) await store.save(chunk);
  const dependencies = { ...f.dependencies, historyStore: store };
  let prepared: GnosisFundingPrepared = await prepareGnosisFundingReview(FUNDING_OWNER, dependencies);
  expect(prepared.audit.status).toBe('reviewable'); await saveGnosisFundingArtifact(prepared);
  const deps = { clock: f.clock, verify: (raw: unknown, owner: string, observedAt: number) => verifyGnosisFundingReview(raw, owner, observedAt, dependencies),
    proveUnsent: (input: Parameters<typeof proveGnosisFundingNoSourceEffect>[0]) => proveGnosisFundingNoSourceEffect(input, dependencies) };
  const input = () => ({ owner: FUNDING_OWNER, phase: 'approve' as 'approve' | 'fund', reviewDigest: prepared.audit.review!.digest, proofDigest: prepared.audit.freshProof!.digest });
  const refresh = async () => { prepared = await prepareGnosisFundingReview(FUNDING_OWNER, dependencies); expect(prepared.audit.status).toBe('reviewable'); await saveGnosisFundingArtifact(prepared); };
  return { ...f, dependencies, deps, input, refresh, prepared };
}
const attempts = () => query<{ key: string; value: { status: string } }>("SELECT key,value FROM app_settings WHERE key LIKE 'wallet:gnosis:owner-funding:v1:%:attempt:%'");
describe('durable owner prompt fence with real PGlite and actual read-only verification', () => {
  it('serializes concurrent reserves, persists exact immutable review/bytes/baselines and never mutates financial state', async () => {
    const f = await fixture(), history = (await query("SELECT key,value,updated_at FROM app_settings WHERE key LIKE 'wallet:gnosis:eur-state:%' ORDER BY key")).rows;
    const results = await Promise.allSettled([reserveGnosisFundingAttempt(f.input(), f.deps), reserveGnosisFundingAttempt(f.input(), f.deps)]);
    expect(results.filter(v => v.status === 'fulfilled')).toHaveLength(1); expect(results.filter(v => v.status === 'rejected')).toHaveLength(1);
    const fulfilled = results.find(v => v.status === 'fulfilled')! as PromiseFulfilledResult<Awaited<ReturnType<typeof reserveGnosisFundingAttempt>>>;
    expect(fulfilled.value.transaction).toEqual({ chainId: 1, from: fulfilled.value.review.owner, to: fulfilled.value.review.approval.token,
      value: '0x0', data: fulfilled.value.review.approval.data });
    expect(fulfilled.value.attempt).toMatchObject({ status: 'reserved', transactionHash: null, phase: 'approve', reviewDigest: f.input().reviewDigest });
    expect(fulfilled.value.freshProof.history.count).toBe(1000); expect((await attempts()).rows).toHaveLength(1);
    expect(parseGnosisFundingReservationUI(fulfilled.value, FUNDING_OWNER, 'approve')).not.toBeNull();
    expect((await query("SELECT key,value,updated_at FROM app_settings WHERE key LIKE 'wallet:gnosis:eur-state:%' ORDER BY key")).rows).toEqual(history);
    expect((await query("SELECT key FROM app_settings WHERE key LIKE 'execution:%' OR key LIKE 'wallet:strategy:%' OR key LIKE 'wallet:cow:%'")).rowCount).toBe(0);
    expect((await query("SELECT * FROM audit_events WHERE event='wallet.gnosis.funding.reserved'")).rowCount).toBe(1);
  });
  it('does not free a missing-hash/unknown fence on expiry, reload, a new quote or another phase', async () => {
    const f = await fixture(), r = await reserveGnosisFundingAttempt(f.input(), f.deps);
    await markGnosisFundingUnknown(FUNDING_OWNER, r.attempt.id);
    f.setNow(FUNDING_NOW + 864000);
    expect(await readGnosisFundingFence(FUNDING_OWNER)).toMatchObject({ blocked: true, active: { id: r.attempt.id, status: 'unknown', transactionHash: null } });
    f.setNow(FUNDING_NOW); await f.refresh();
    await expect(reserveGnosisFundingAttempt(f.input(), f.deps)).rejects.toThrow('wallet_gnosis_funding_attempt_pending');
    f.state.allowance = 10000000n; await f.refresh();
    await expect(reserveGnosisFundingAttempt({ ...f.input(), phase: 'fund' }, f.deps)).rejects.toThrow('wallet_gnosis_funding_attempt_pending');
    expect((await resolveGnosisFundingAttempt(FUNDING_OWNER, r.attempt.id)).fence.blocked).toBe(true);
    expect((await attempts()).rows).toHaveLength(1);
  });
  it('records a returned hash after view expiry, idempotently, and rejects hash replacement or a claimed rejection after send', async () => {
    const f = await fixture(), r = await reserveGnosisFundingAttempt(f.input(), f.deps); f.setNow(FUNDING_NOW + 1000);
    expect((await recordGnosisFundingHash(FUNDING_OWNER, r.attempt.id, hash)).attempt.transactionHash).toBe(hash);
    expect((await recordGnosisFundingHash(FUNDING_OWNER, r.attempt.id, hash)).attempt.status).toBe('hash-recorded');
    await expect(recordGnosisFundingHash(FUNDING_OWNER, r.attempt.id, otherHash)).rejects.toThrow('wallet_gnosis_funding_attempt_changed');
    await expect(attestGnosisFundingRejection(FUNDING_OWNER, r.attempt.id, 4001)).rejects.toThrow('wallet_gnosis_funding_attempt_changed');
    await expect(cancelGnosisFundingUnsent(FUNDING_OWNER, r.attempt.id, r.attempt.snapshotDigest, false, f.deps)).rejects.toThrow('wallet_gnosis_funding_attempt_changed');
    expect((await readGnosisFundingFence(FUNDING_OWNER)).blocked).toBe(true);
  });
  it('accepts only the explicit owner 4001 attestation without a hash and retains the old attempt instead of deleting it', async () => {
    const f = await fixture(), r = await reserveGnosisFundingAttempt(f.input(), f.deps);
    await expect(attestGnosisFundingRejection(FUNDING_OWNER, r.attempt.id, -32000)).rejects.toThrow('wallet_gnosis_funding_request_invalid');
    const result = await attestGnosisFundingRejection(FUNDING_OWNER, r.attempt.id, 4001);
    expect(result).toMatchObject({ attempt: { status: 'owner-rejected', transactionHash: null }, fence: { blocked: false, active: null } });
    await reserveGnosisFundingAttempt(f.input(), f.deps); expect((await attempts()).rows).toHaveLength(2);
  });
  it('recovers a provably unchanged pre-request snapshot only with the exact unsent attestation, never after unknown', async () => {
    const f = await fixture(), r = await reserveGnosisFundingAttempt(f.input(), f.deps);
    await expect(cancelGnosisFundingUnsent(FUNDING_OWNER, r.attempt.id, otherHash, false, f.deps)).rejects.toThrow('wallet_gnosis_funding_attempt_changed');
    f.state.balance--;
    await expect(cancelGnosisFundingUnsent(FUNDING_OWNER, r.attempt.id, r.attempt.snapshotDigest, false, f.deps)).rejects.toThrow('wallet_gnosis_funding_unsent_not_proved');
    f.state.balance++;
    const result = await cancelGnosisFundingUnsent(FUNDING_OWNER, r.attempt.id, r.attempt.snapshotDigest, false, f.deps);
    expect(result).toMatchObject({ attempt: { status: 'owner-cancelled-unsent', unsentAttestationProof: expect.stringMatching(/^0x[0-9a-f]{64}$/) }, fence: { blocked: false } });
    const next = await reserveGnosisFundingAttempt(f.input(), f.deps); await markGnosisFundingUnknown(FUNDING_OWNER, next.attempt.id);
    await expect(cancelGnosisFundingUnsent(FUNDING_OWNER, next.attempt.id, next.attempt.snapshotDigest, false, f.deps)).rejects.toThrow('wallet_gnosis_funding_attempt_changed');
  });
  it('blocks a source quarantine or review revision committed during the RPC awaits before any reservation is saved', async () => {
    const f = await fixture();
    await expect(reserveGnosisFundingAttempt(f.input(), { ...f.deps, verify: async (...args) => {
      const verified = await f.deps.verify(args[0], args[1], args[2]); await query('UPDATE app_settings SET value=$2::jsonb WHERE key=$1', [fenceKey, JSON.stringify({ version: 1, quarantined: true })]); return verified;
    } })).rejects.toThrow('wallet_gnosis_funding_history_required');
    expect((await attempts()).rows).toHaveLength(0);
  });
  it('rejects stale proof after a SQL wait and requires exact finite allowance before reserving the fund action', async () => {
    const f = await fixture();
    await expect(reserveGnosisFundingAttempt({ ...f.input(), phase: 'fund' }, f.deps)).rejects.toThrow('wallet_gnosis_funding_finite_approval_required');
    await expect(reserveGnosisFundingAttempt(f.input(), { ...f.deps, transact: work => transaction(tx => { f.setNow(FUNDING_NOW + 16); return work(tx); }) })).rejects.toThrow('wallet_gnosis_funding_stale');
    expect((await attempts()).rows).toHaveLength(0);
  });
  it('promotes an independently resolved approval, permits the one finite fund phase, and never authorizes a second completed funding', async () => {
    const f = await fixture(), approval = await reserveGnosisFundingAttempt(f.input(), f.deps); await recordGnosisFundingHash(FUNDING_OWNER, approval.attempt.id, hash);
    const resolved: GnosisFundingResolution = { transactionHash: hash, receiptBlock: { number: '1', hash, timestamp: FUNDING_NOW }, finalizedBlock: { number: '2', hash: otherHash, timestamp: FUNDING_NOW },
      evidenceDigest: hash, sourceTokenOutflowRaw: '0', outcome: 'confirmed', destinationArrival: 'not-certified' };
    expect((await resolveGnosisFundingAttempt(FUNDING_OWNER, approval.attempt.id, { resolve: async () => resolved })).fence).toMatchObject({ blocked: false, lastApproval: { status: 'confirmed' } });
    f.state.allowance = 10000000n; await f.refresh();
    const fund = await reserveGnosisFundingAttempt({ ...f.input(), phase: 'fund' }, f.deps); await recordGnosisFundingHash(FUNDING_OWNER, fund.attempt.id, otherHash);
    const result = await resolveGnosisFundingAttempt(FUNDING_OWNER, fund.attempt.id, { resolve: async () => ({ ...resolved, transactionHash: otherHash, sourceTokenOutflowRaw: '10000000' }) });
    expect(result).toMatchObject({ attempt: { status: 'confirmed', resolution: { destinationArrival: 'not-certified' } }, fence: { blocked: true, active: null, fundCompleted: true } });
    await expect(reserveGnosisFundingAttempt({ ...f.input(), phase: 'fund' }, f.deps)).rejects.toThrow('wallet_gnosis_funding_attempt_pending');
  });
  it('keeps uncertain hashes fenced when resolution is unavailable or lacks matching action evidence', async () => {
    const f = await fixture(), r = await reserveGnosisFundingAttempt(f.input(), f.deps); await recordGnosisFundingHash(FUNDING_OWNER, r.attempt.id, hash);
    expect((await resolveGnosisFundingAttempt(FUNDING_OWNER, r.attempt.id, { resolve: async () => null })).fence.blocked).toBe(true);
    await expect(resolveGnosisFundingAttempt(FUNDING_OWNER, r.attempt.id, { resolve: async () => { throw new Error('unavailable'); } })).rejects.toThrow();
    expect((await readGnosisFundingFence(FUNDING_OWNER)).active?.transactionHash).toBe(hash);
  });
  it('fails closed on corrupted persisted evidence instead of interpreting it as an empty fence', async () => {
    const f = await fixture(), r = await reserveGnosisFundingAttempt(f.input(), f.deps);
    await query("UPDATE app_settings SET value=jsonb_set(value,'{proofJson}',to_jsonb($2::text)) WHERE key=$1", [
      `wallet:gnosis:owner-funding:v1:${r.attempt.owner.toLowerCase()}:attempt:${r.attempt.id}`, '{}']);
    await expect(readGnosisFundingFence(FUNDING_OWNER)).rejects.toThrow('wallet_gnosis_funding_attempt_invalid');
  });
  it('retains a missing-hash unknown fence through an actual disk database restart', async () => {
    await closeDatabase(); const folder = await realpath(await mkdtemp(join(tmpdir(), 'mirsad-funding-fence-')));
    try {
      vi.stubEnv('LOCAL_DATABASE_PATH', folder); const f = await fixture(), r = await reserveGnosisFundingAttempt(f.input(), f.deps);
      await markGnosisFundingUnknown(FUNDING_OWNER, r.attempt.id); await closeDatabase();
      expect(await readGnosisFundingFence(FUNDING_OWNER)).toMatchObject({ blocked: true, active: { id: r.attempt.id, status: 'unknown', transactionHash: null } });
    } finally {
      await closeDatabase();
      if (dirname(folder) !== resolve(tmpdir()) || !basename(folder).startsWith('mirsad-funding-fence-')) throw new Error('Temporary path outside expected root');
      await rm(folder, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it } from 'vitest';
import { assertExecutorGasReservationFresh, executorGasBudgetUI, parseExecutorGasReservationUI, parseExecutorGasReviewUI,
  parseExecutorGasAttemptResultUI } from '../src/lib/wallet/gnosis-executor-gas-ui';
import { COW_GNOSIS_SETUP_GAS_LIMITS } from '../src/lib/wallet/wallet-feasibility';
import { emptyGasFence, gasAt, gasExecutor, gasOwner, gasReservation, gasResolved, GH, rehashGasReservation } from './fixtures/executor-gas-ui';
import type { ExecutorGasReservation } from '../src/lib/wallet/gnosis-executor-gas-attempts';

describe('bounded executor native gas review (local software only)', () => {
  it('recomputes the compiled 20-transaction reserve and separate two-leg gas bound', () => {
    expect(executorGasBudgetUI(COW_GNOSIS_SETUP_GAS_LIMITS)).toEqual({ maxPhaseCostWei: '35000000000000', reserveMultiplier: 20,
      targetBalanceWei: '700000000000000', minimumRoundTripWei: '112000000000000' });
  });
  it('rejects arbitrary gas-policy fields, oversized phase caps and priority above fee', () => {
    for (const limits of [{ ...COW_GNOSIS_SETUP_GAS_LIMITS, nonce: 1 },
      { ...COW_GNOSIS_SETUP_GAS_LIMITS, maxPriorityFeePerGasWei: '100000001' },
      { ...COW_GNOSIS_SETUP_GAS_LIMITS, phaseMaxGas: { ...COW_GNOSIS_SETUP_GAS_LIMITS.phaseMaxGas, cancel: '350001' } }])
      expect(() => executorGasBudgetUI(limits)).toThrow();
  });
  it('roundtrips server-bound review/proof/snapshot and exact existing-balance shortfall', () => {
    const r = gasReservation('300000000000000');
    expect(parseExecutorGasReservationUI({ ...r, csrfToken: 'not-forwarded' }, gasOwner, gasExecutor)).toEqual(r);
    expect(r.review.shortfallWei).toBe('400000000000000');
    expect(() => assertExecutorGasReservationFresh(r, gasAt + 14)).not.toThrow();
    expect(() => assertExecutorGasReservationFresh(r, gasAt + 15)).toThrow('wallet_executor_gas_stale');
    expect(parseExecutorGasReservationUI(gasReservation('700000000000000'), gasOwner, gasExecutor)).toBeNull();
  });
  it('rejects arbitrary recipient, native value, calldata, gas fields and wrong chain despite rehashed review', () => {
    for (const mutate of [(r: ExecutorGasReservation) => { r.transaction.to = gasOwner; },
      (r: ExecutorGasReservation) => { r.transaction.value = '0x1'; },
      (r: ExecutorGasReservation) => { r.transaction.data = '0x00' as '0x'; },
      (r: ExecutorGasReservation) => { Object.assign(r.transaction, { nonce: '0x3' }); },
      (r: ExecutorGasReservation) => { r.transaction.chainId = 1 as 100; }]) {
      const r = gasReservation(); mutate(r); rehashGasReservation(r);
      expect(parseExecutorGasReservationUI(r, gasOwner, gasExecutor)).toBeNull();
    }
    expect(parseExecutorGasReservationUI(gasReservation(), gasOwner, gasOwner)).toBeNull();
    expect(parseExecutorGasReservationUI(gasReservation(), gasExecutor, gasExecutor)).toBeNull();
  });
  it('rejects self-consistent rehashed inflated reserve, invalid retained budget or stale profile proof', () => {
    for (const mutate of [(r: ExecutorGasReservation) => { r.review.targetBalanceWei = '1400000000000000'; },
      (r: ExecutorGasReservation) => { r.review.reserveMultiplier = 21 as 20; },
      (r: ExecutorGasReservation) => { r.review.ownerRetainedWei = '1'; },
      (r: ExecutorGasReservation) => { r.review.ownerReserveWei = '0'; },
      (r: ExecutorGasReservation) => { r.review.ownerTransferFeeUpperWei = '0'; r.review.ownerRetainedWei = (BigInt(r.review.ownerBalanceWei) - BigInt(r.review.shortfallWei)).toString(); },
      (r: ExecutorGasReservation) => { r.freshProof.profileRevision++; },
      (r: ExecutorGasReservation) => { r.freshProof.sourcePendingNonce--; },
      (r: ExecutorGasReservation) => { r.freshProof.runtimeDigest = ('0x' + 'cd'.repeat(32)) as typeof GH; }]) {
      const r = gasReservation(); mutate(r); rehashGasReservation(r);
      expect(parseExecutorGasReservationUI(r, gasOwner, gasExecutor)).toBeNull();
    }
  });
  it('separates review lifetime from 15-second reservation and rejects missing/wrong source evidence', () => {
    const r = gasReservation(), audit = { version: 1, chainId: 100, owner: gasOwner, executor: gasExecutor,
      status: 'reviewable', readAt: gasAt, expiresAt: gasAt + 90, review: r.review, freshProof: r.freshProof,
      blockers: [], ownerReviewAllowed: true, executionApproved: false, fence: emptyGasFence() };
    expect(parseExecutorGasReviewUI(audit, gasOwner, gasExecutor)?.ownerReviewAllowed).toBe(true);
    expect(parseExecutorGasReviewUI({ ...audit, freshProof: null }, gasOwner, gasExecutor)).toBeNull();
    expect(parseExecutorGasReviewUI({ ...audit, review: { ...r.review, ownerCosts: 'all-fees-known' } }, gasOwner, gasExecutor)).toBeNull();
    const blocked = { ...audit, status: 'blocked', review: null, freshProof: null, ownerReviewAllowed: false, expiresAt: gasAt, blockers: ['source_missing'] };
    expect(parseExecutorGasReviewUI(blocked, gasOwner, gasExecutor)?.status).toBe('blocked');
    const funded = gasReservation('700000000000000');
    expect(funded.review).toMatchObject({ shortfallWei: '0', ownerTransferGasUnits: '0', ownerTransferFeeUpperWei: '0' });
    expect(parseExecutorGasReviewUI({ ...audit, status: 'funded', review: funded.review, freshProof: funded.freshProof, ownerReviewAllowed: false }, gasOwner, gasExecutor)?.status).toBe('funded');
  });
  it('requires exact native receipt identity/expense and explicit unsent attestation', () => {
    const r = gasReservation(), done = gasResolved(r);
    expect(parseExecutorGasAttemptResultUI(done, gasOwner, gasExecutor)).toEqual(done);
    expect(parseExecutorGasAttemptResultUI({ fence: emptyGasFence() }, gasOwner, gasExecutor)).toEqual({ attempt: null, fence: emptyGasFence() });
    expect(parseExecutorGasAttemptResultUI(done, gasOwner, gasOwner)).toBeNull();
    expect(parseExecutorGasAttemptResultUI({ ...done, attempt: { ...done.attempt, resolution: null } }, gasOwner, gasExecutor)).toBeNull();
    const wrongFee = structuredClone(done); wrongFee.attempt.resolution!.actualGasWei = '1';
    expect(parseExecutorGasAttemptResultUI(wrongFee, gasOwner, gasExecutor)).toBeNull();
    const zeroFee = structuredClone(done); zeroFee.attempt.resolution!.effectiveGasPriceWei = '0'; zeroFee.attempt.resolution!.actualGasWei = '0';
    expect(parseExecutorGasAttemptResultUI(zeroFee, gasOwner, gasExecutor)).toEqual(zeroFee);
    const zeroPrincipal = structuredClone(done); zeroPrincipal.attempt.resolution!.valueWei = '0';
    expect(parseExecutorGasAttemptResultUI(zeroPrincipal, gasOwner, gasExecutor)).toBeNull();
    const reverted = gasResolved(r, 'reverted');
    expect(parseExecutorGasAttemptResultUI(reverted, gasOwner, gasExecutor)).toEqual(reverted);
    reverted.attempt.resolution!.valueWei = r.review.shortfallWei;
    expect(parseExecutorGasAttemptResultUI(reverted, gasOwner, gasExecutor)).toBeNull();
    const unsent = gasResolved(r, 'owner-cancelled-unsent');
    expect(parseExecutorGasAttemptResultUI(unsent, gasOwner, gasExecutor)).toEqual(unsent);
    delete unsent.attempt.unsentAttestationProof;
    expect(parseExecutorGasAttemptResultUI(unsent, gasOwner, gasExecutor)).toBeNull();
  });
});

import { randomUUID } from 'node:crypto';
import { getAddress, toHex, type Hex } from 'viem';
import { executorGasBudgetUI, executorGasUIDigest } from '../../src/lib/wallet/gnosis-executor-gas-ui';
import { COW_GNOSIS_SETUP_GAS_LIMITS } from '../../src/lib/wallet/wallet-feasibility';
import type { ExecutorGasAttemptView, ExecutorGasFence, ExecutorGasReservation } from '../../src/lib/wallet/gnosis-executor-gas-attempts';
import type { ExecutorGasFreshProof, ExecutorGasReview } from '../../src/lib/wallet/gnosis-executor-gas';

// Entire fixture is synthetic local validation evidence; no chain reads, private
// keys, wallet signatures or financial transfers are performed or represented.
export const gasOwner = getAddress('0x' + 'a'.repeat(40)), gasExecutor = getAddress('0x' + 'b'.repeat(40));
export const gasAt = 1794800000, GH = ('0x' + 'ab'.repeat(32)) as Hex;
export const emptyGasFence = (): ExecutorGasFence => ({ blocked: false, active: null, last: null });
export function gasReservation(executorBalanceWei = '0', sourceNonce = 3): ExecutorGasReservation {
  const gasLimits = structuredClone(COW_GNOSIS_SETUP_GAS_LIMITS), budget = executorGasBudgetUI(gasLimits);
  const shortfallWei = (BigInt(budget.targetBalanceWei) > BigInt(executorBalanceWei) ? BigInt(budget.targetBalanceWei) - BigInt(executorBalanceWei) : 0n).toString();
  const latestBlock = { number: '1000', hash: GH, parentHash: GH, timestamp: gasAt }, finalizedBlock = { number: '970', hash: GH, parentHash: GH, timestamp: gasAt - 150 };
  const transaction = { chainId: 100 as const, from: gasOwner, to: gasExecutor, value: toHex(BigInt(shortfallWei)), data: '0x' as const };
  const transferFee = shortfallWei === '0' ? 0n : 2100000000000n;
  const base = { version: 1 as const, method: 'gnosis-executor-native-gas-v1' as const, chainId: 100 as const, owner: gasOwner, executor: gasExecutor,
    profileRevision: 7, runtimeDigest: GH, gasPolicyDigest: executorGasUIDigest(gasLimits), gasLimits, ...budget,
    executorBalanceWei, shortfallWei, ownerBalanceWei: '10000000000000000', ownerTransferGasUnits: shortfallWei === '0' ? '0' : '21000', ownerTransferFeeUpperWei: transferFee.toString(),
    ownerDeploymentReserveWei: '100000000000000', ownerReserveWei: '212000000000000',
    ownerRetainedWei: (10000000000000000n - BigInt(shortfallWei) - transferFee).toString(),
    ownerCosts: 'runtime-fee-cap-review-budget-wallet-fees-and-other-setup-not-certified' as const, sourceNonce, sourcePendingNonce: sourceNonce,
    latestBlock, finalizedBlock, issuedAt: gasAt, expiresAt: gasAt + 90, transaction };
  const review: ExecutorGasReview = { ...base, digest: executorGasUIDigest(base) };
  const proofBase = { version: 1 as const, owner: gasOwner, executor: gasExecutor, profileRevision: review.profileRevision, reviewDigest: review.digest,
    runtimeDigest: review.runtimeDigest, gasPolicyDigest: review.gasPolicyDigest, ownerBalanceWei: review.ownerBalanceWei,
    executorBalanceWei, shortfallWei, sourceNonce: review.sourceNonce, sourcePendingNonce: review.sourcePendingNonce,
    latestBlock, finalizedBlock, readAt: gasAt, expiresAt: gasAt + 15 };
  const freshProof: ExecutorGasFreshProof = { ...proofBase, digest: executorGasUIDigest(proofBase) };
  const attemptBase = { id: randomUUID(), owner: gasOwner, executor: gasExecutor, profileRevision: review.profileRevision, runtimeDigest: review.runtimeDigest,
    reviewDigest: review.digest, proofDigest: freshProof.digest, issuedAt: freshProof.readAt, expiresAt: freshProof.expiresAt };
  return { version: 1, review, freshProof, transaction, attempt: { ...attemptBase, status: 'reserved', transactionHash: null, resolution: null,
    snapshotDigest: executorGasUIDigest({ ...attemptBase, review, freshProof, transaction }) } };
}
export function gasResolved(r: ExecutorGasReservation, status: 'confirmed' | 'reverted' | 'owner-rejected' | 'owner-cancelled-unsent' = 'confirmed') {
  const noSend = status === 'owner-rejected' || status === 'owner-cancelled-unsent';
  const attempt: ExecutorGasAttemptView = { ...r.attempt, status, transactionHash: noSend ? null : GH,
    resolution: noSend ? null : { chainId: 100, owner: r.review.owner, executor: r.review.executor, transactionHash: GH,
      nonce: r.freshProof.sourcePendingNonce, valueWei: status === 'reverted' ? '0' : r.review.shortfallWei, gasUsed: '21000', effectiveGasPriceWei: '100000000', actualGasWei: '2100000000000',
      receiptBlock: { number: '1001', hash: GH, timestamp: gasAt + 5 }, finalizedBlock: { number: '1031', hash: GH, timestamp: gasAt + 155 },
      outcome: status, evidenceDigest: GH }, ...(status === 'owner-cancelled-unsent' ? { unsentAttestationProof: GH } : {}) };
  return { attempt, fence: { ...emptyGasFence(), last: attempt } };
}
export function rehashGasReservation(r: ExecutorGasReservation) {
  const { digest: _review, ...review } = r.review; r.review.digest = executorGasUIDigest(review);
  Object.assign(r.freshProof, { reviewDigest: r.review.digest }); const { digest: _proof, ...proof } = r.freshProof; r.freshProof.digest = executorGasUIDigest(proof);
  Object.assign(r.attempt, { reviewDigest: r.review.digest, proofDigest: r.freshProof.digest });
  const a = r.attempt; a.snapshotDigest = executorGasUIDigest({ id: a.id, owner: a.owner, executor: a.executor, profileRevision: a.profileRevision,
    runtimeDigest: a.runtimeDigest, reviewDigest: a.reviewDigest, proofDigest: a.proofDigest, issuedAt: a.issuedAt, expiresAt: a.expiresAt,
    review: r.review, freshProof: r.freshProof, transaction: r.transaction });
}

import { randomUUID } from 'node:crypto';
import { getAddress } from 'viem';
import { authorityDigest, type AuthorityCloseReview, type AuthorityReview } from '../../src/lib/wallet/authority';
import { authorityActionUISnapshot, type AuthorityActionPhase, type AuthorityActionReservation } from '../../src/lib/wallet/authority-action-ui';

/** Synthetic server reservation for an isolated wallet-provider test. No keys,
 * chain transaction or canonical receipt is created by this fixture. */
export function authorityReservation(review: AuthorityReview, phase: AuthorityActionPhase, close?: AuthorityCloseReview): AuthorityActionReservation {
  const payload: AuthorityActionReservation['payload'] = phase === 'deploy'
    ? { kind: 'transaction', transaction: { chainId: review.chainId, from: getAddress(review.owner), ...review.deploymentStep!.transaction } }
    : { kind: 'calls', chainId: review.chainId, from: getAddress(review.owner), atomicRequired: true, calls: structuredClone(close?.calls ?? review.calls) };
  const now = Math.floor(Date.now() / 1000);
  const r: AuthorityActionReservation = { version: 1, review: structuredClone(review), close: close ? structuredClone(close) : null, payload,
    attempt: { id: randomUUID(), accountId: 'metamask-strategy-v1', owner: getAddress(review.owner), chainId: review.chainId,
      reviewId: review.id, reviewDigest: review.digest, profileRevision: review.profileRevision, authorityRevision: 1,
      phase, closeDigest: close?.digest ?? null, payloadDigest: authorityDigest(payload), snapshotDigest: authorityDigest(null),
      issuedAt: now, expiresAt: close?.reviewExpiresAt ?? review.reviewExpiresAt, status: 'reserved',
      ownerPendingNonce: review.deploymentStep ? Number(BigInt(review.deploymentStep.transaction.nonce)) : 0,
      sourceBlock: { ...review.block, timestamp: now }, transactionHashes: [], callBatchIds: [], resolution: null } };
  r.attempt.snapshotDigest = authorityActionUISnapshot(r); return r;
}

import { randomUUID } from 'node:crypto';
import { getAddress, type Hex } from 'viem';
import quote from './lifi-gnosis-funding-quote.json';
import { parseGnosisFundingQuote } from '../../src/lib/wallet/gnosis-funding-quote';
import { fundingDigest, type GnosisFundingFreshProof } from '../../src/lib/wallet/gnosis-funding-service';
import type { GnosisFundingAttemptView, GnosisFundingFence, GnosisFundingPhase, GnosisFundingReservation } from '../../src/lib/wallet/gnosis-funding-attempts';

// Recorded public vendor quote plus explicitly synthetic local chain evidence.
// No RPC, signature, financial action or production readiness is exercised.
export const fundingOwner = getAddress(quote.quote.action.fromAddress.toLowerCase());
export const fundingAt = Math.floor(Date.parse(quote.observedAt) / 1000);
export const H = ('0x' + 'ab'.repeat(32)) as Hex;
export const emptyFundingFence = (): GnosisFundingFence => ({ blocked: false, active: null, lastApproval: null, fundCompleted: false });
export async function fundingReservation(phase: GnosisFundingPhase = 'fund'): Promise<GnosisFundingReservation> {
  const review = await parseGnosisFundingQuote(quote.quote, { owner: fundingOwner, observedAt: fundingAt, now: fundingAt });
  const closeTime = Math.floor(fundingAt / 900) * 900;
  const proofBase = { version: 1 as const, owner: fundingOwner, reviewDigest: review.digest, manifestHash: review.manifestHash,
    sourceBlock: { number: '100', hash: H, parentHash: H, timestamp: fundingAt },
    destinationBlock: { number: '200', hash: H, parentHash: H, timestamp: fundingAt },
    readAt: fundingAt, expiresAt: fundingAt + 15, sourceBalanceRaw: '10807268', sourceAllowanceRaw: phase === 'fund' ? '10000000' : '0',
    sourceNativeBalanceWei: '0', sourceNonce: 2, sourcePendingNonce: 2, destinationTokenBalanceRaw: '0', destinationNativeBalanceWei: '0', checksDigest: H,
    history: { identity: 'gnosis-reference:v1:' + 'a'.repeat(64), firstCloseTime: closeTime - 999 * 900, closeTime, count: 1000 as const,
      fingerprint: H, scope: 'compiled-cache-24h-snapshot-not-entry-readiness' as const },
    scope: 'current-canonical-snapshot-not-future-contract-or-arrival-guarantee' as const };
  const freshProof: GnosisFundingFreshProof = { ...proofBase, digest: fundingDigest(proofBase) };
  const tx = phase === 'approve' ? { chainId: 1 as const, from: fundingOwner, to: review.approval.token, value: '0x0' as const, data: review.approval.data } : review.transaction;
  const base = { id: randomUUID(), owner: fundingOwner, phase, reviewDigest: review.digest, proofDigest: freshProof.digest,
    issuedAt: freshProof.readAt, expiresAt: freshProof.expiresAt };
  return { version: 1, review, freshProof, transaction: tx, attempt: { ...base, status: 'reserved', transactionHash: null, resolution: null,
    snapshotDigest: fundingDigest({ ...base, review, freshProof, transaction: tx }) } };
}
export function fundingResolved(r: GnosisFundingReservation, status: 'confirmed' | 'reverted' | 'owner-rejected' = 'confirmed', hash = H) {
  const a: GnosisFundingAttemptView = { ...r.attempt, status, transactionHash: status === 'owner-rejected' ? null : hash,
    resolution: status === 'owner-rejected' ? null : { transactionHash: hash, receiptBlock: { number: '101', hash: H, timestamp: fundingAt + 2 },
      finalizedBlock: { number: '102', hash: H, timestamp: fundingAt + 3 }, sourceTokenOutflowRaw: '0', evidenceDigest: H,
      destinationArrival: 'not-certified', outcome: status } };
  return { attempt: a, fence: { ...emptyFundingFence(), blocked: status === 'confirmed' && a.phase === 'fund',
    fundCompleted: status === 'confirmed' && a.phase === 'fund', lastApproval: status === 'confirmed' && a.phase === 'approve' ? a : null } };
}

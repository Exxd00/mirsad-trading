import { getAddress, keccak256, stringToHex, toHex, zeroAddress, type Hex } from 'viem';
import { z } from 'zod';
import type { CowGasLimits } from './cow-execution-types';
import { COW_GNOSIS_SETUP_GAS_LIMITS } from './wallet-feasibility';
import type { ExecutorGasAudit, ExecutorGasFreshProof, ExecutorGasReview } from './gnosis-executor-gas';
import type { ExecutorGasAttemptView, ExecutorGasFence, ExecutorGasReservation } from './gnosis-executor-gas-attempts';

export type { ExecutorGasAudit, ExecutorGasReview, ExecutorGasFreshProof, ExecutorGasAttemptView, ExecutorGasFence, ExecutorGasReservation };
export type ExecutorGasAttemptResultUI = { attempt: ExecutorGasAttemptView | null; fence: ExecutorGasFence };

// Browser-only validation helpers: no RPC, private executor key or signer.
export function executorGasUIDigest(value: unknown): Hex {
  return keccak256(stringToHex(JSON.stringify(value, (_, x) => x !== null && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x)));
}
const positive = z.string().regex(/^[1-9]\d{0,38}$/);
const gasLimitsSchema = z.object({ maxGas: positive, maxFeePerGasWei: positive, maxPriorityFeePerGasWei: positive,
  maxTransactionCostWei: positive, phaseMaxGas: z.object({ presign: positive, cancel: positive, 'clear-presign': positive }).strict().optional() }).strict();
const fail = (): never => { throw new Error('wallet_executor_gas_review_invalid'); };
/** Recompute the reviewed reserve, never a count of cycles or an automatic topup.
 * A presign and clearance share one nonce; cancellation uses the next nonce. */
export function executorGasBudgetUI(value: CowGasLimits) {
  const limits = gasLimitsSchema.parse(value), fee = BigInt(limits.maxFeePerGasWei), cap = BigInt(limits.maxTransactionCostWei);
  if (BigInt(limits.maxPriorityFeePerGasWei) > fee) fail();
  const phases = ['presign', 'cancel', 'clear-presign'] as const;
  const amounts = phases.map(phase => {
    const gas = BigInt(limits.phaseMaxGas?.[phase] ?? limits.maxGas);
    if (gas > BigInt(limits.maxGas)) return fail();
    return gas * fee < cap ? gas * fee : cap;
  });
  const maxPhaseCostWei = amounts.reduce((max, v) => v > max ? v : max);
  const competingNonce = amounts[0] > amounts[2] ? amounts[0] : amounts[2];
  return { maxPhaseCostWei: maxPhaseCostWei.toString(), reserveMultiplier: 20 as const,
    targetBalanceWei: (20n * maxPhaseCostWei).toString(), minimumRoundTripWei: (2n * (competingNonce + amounts[1])).toString() };
}
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(v => getAddress(v.toLowerCase()));
const hash = z.string().regex(/^0x[0-9a-f]{64}$/).transform(v => v as Hex);
const raw = z.string().regex(/^(?:0|[1-9]\d{0,77})$/).refine(v => BigInt(v) < 1n << 256n);
const time = z.number().int().nonnegative().max(253402300799);
const nonce = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const quantity = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/).transform(v => v as Hex);
const block = z.object({ number: raw, hash, parentHash: hash, timestamp: time }).strict();
const transaction = z.object({ chainId: z.literal(100), from: address, to: address, value: quantity, data: z.literal('0x') }).strict();
const reviewSchema = z.object({ version: z.literal(1), method: z.literal('gnosis-executor-native-gas-v1'), chainId: z.literal(100),
  owner: address, executor: address, profileRevision: revision, runtimeDigest: hash, gasPolicyDigest: hash, gasLimits: gasLimitsSchema,
  maxPhaseCostWei: raw, reserveMultiplier: z.literal(20), targetBalanceWei: raw, minimumRoundTripWei: raw, executorBalanceWei: raw,
  shortfallWei: raw, ownerBalanceWei: raw, ownerTransferGasUnits: raw, ownerTransferFeeUpperWei: raw,
  ownerDeploymentReserveWei: raw, ownerReserveWei: raw, ownerRetainedWei: raw,
  ownerCosts: z.literal('runtime-fee-cap-review-budget-wallet-fees-and-other-setup-not-certified'), sourceNonce: nonce, sourcePendingNonce: nonce,
  latestBlock: block, finalizedBlock: block, issuedAt: time, expiresAt: time, transaction, digest: hash }).strict();
const proofSchema = z.object({ version: z.literal(1), owner: address, executor: address, profileRevision: revision, reviewDigest: hash,
  runtimeDigest: hash, gasPolicyDigest: hash, ownerBalanceWei: raw, executorBalanceWei: raw, shortfallWei: raw,
  sourceNonce: nonce, sourcePendingNonce: nonce, latestBlock: block, finalizedBlock: block, readAt: time, expiresAt: time, digest: hash }).strict();
const receiptBlock = block.omit({ parentHash: true }).strict();
const resolution = z.object({ chainId: z.literal(100), owner: address, executor: address, transactionHash: hash, nonce,
  valueWei: raw, gasUsed: positive, effectiveGasPriceWei: raw, actualGasWei: raw, receiptBlock, finalizedBlock: receiptBlock,
  outcome: z.enum(['confirmed', 'reverted']), evidenceDigest: hash }).strict();
const attemptSchema = z.object({ id: z.string().uuid(), owner: address, executor: address, profileRevision: revision, runtimeDigest: hash,
  status: z.enum(['reserved', 'hash-recorded', 'unknown', 'owner-rejected', 'owner-cancelled-unsent', 'confirmed', 'reverted']), reviewDigest: hash,
  proofDigest: hash, snapshotDigest: hash, issuedAt: time, expiresAt: time, transactionHash: hash.nullable(), resolution: resolution.nullable(),
  unsentAttestationProof: hash.optional() }).strict();
const fenceSchema = z.object({ blocked: z.boolean(), active: attemptSchema.nullable(), last: attemptSchema.nullable() }).strict();
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const clone = (value: unknown): unknown => { const json = JSON.stringify(value); if (!json || json.length > 40000) return fail(); return JSON.parse(json) as unknown; };
function owners(owner: string, executor: string, expectedOwner: string, expectedExecutor: string) {
  if (!same(owner, expectedOwner) || !same(executor, expectedExecutor) || owner === zeroAddress || executor === zeroAddress || same(owner, executor)) fail();
}
function blocks(latest: z.infer<typeof block>, finalized: z.infer<typeof block>, at: number) {
  if (BigInt(latest.number) < BigInt(finalized.number) || latest.timestamp > at || finalized.timestamp > latest.timestamp
    || at - latest.timestamp > 15 || at - finalized.timestamp > 600 || latest.number === finalized.number && latest.hash !== finalized.hash) fail();
}
function checkedReview(value: unknown, owner: string, executor: string): ExecutorGasReview {
  const r = reviewSchema.parse(value), { digest, ...base } = r;
  owners(r.owner, r.executor, owner, executor); blocks(r.latestBlock, r.finalizedBlock, r.issuedAt);
  const calculated = executorGasBudgetUI(r.gasLimits);
  if (executorGasUIDigest(base) !== digest || executorGasUIDigest(r.gasLimits) !== r.gasPolicyDigest
    || r.sourcePendingNonce < r.sourceNonce || r.expiresAt <= r.issuedAt || r.expiresAt > r.issuedAt + 90
    || Object.entries(calculated).some(([key, v]) => r[key as keyof typeof r] !== v)
    || BigInt(r.gasLimits.maxGas) > BigInt(COW_GNOSIS_SETUP_GAS_LIMITS.maxGas)
    || BigInt(r.gasLimits.maxFeePerGasWei) > BigInt(COW_GNOSIS_SETUP_GAS_LIMITS.maxFeePerGasWei)
    || BigInt(r.gasLimits.maxTransactionCostWei) > BigInt(COW_GNOSIS_SETUP_GAS_LIMITS.maxTransactionCostWei)) fail();
  const shortfall = BigInt(r.targetBalanceWei) > BigInt(r.executorBalanceWei) ? BigInt(r.targetBalanceWei) - BigInt(r.executorBalanceWei) : 0n;
  if (BigInt(r.shortfallWei) !== shortfall || !same(r.transaction.from, owner) || !same(r.transaction.to, executor)
    || (shortfall === 0n ? r.ownerTransferGasUnits !== '0' : BigInt(r.ownerTransferGasUnits) < 21000n)
    || BigInt(r.ownerTransferFeeUpperWei) !== BigInt(r.ownerTransferGasUnits) * BigInt(r.gasLimits.maxFeePerGasWei)
    || r.transaction.value !== toHex(shortfall) || BigInt(r.ownerBalanceWei) < shortfall + BigInt(r.ownerTransferFeeUpperWei)
    || BigInt(r.ownerRetainedWei) !== BigInt(r.ownerBalanceWei) - shortfall - BigInt(r.ownerTransferFeeUpperWei)
    || BigInt(r.ownerRetainedWei) < BigInt(r.ownerReserveWei)
    || BigInt(r.ownerReserveWei) !== BigInt(r.ownerDeploymentReserveWei) + BigInt(r.minimumRoundTripWei)) fail();
  return r;
}
function checkedProof(value: unknown, r: ExecutorGasReview): ExecutorGasFreshProof {
  const p = proofSchema.parse(value), { digest, ...base } = p;
  owners(p.owner, p.executor, r.owner, r.executor); blocks(p.latestBlock, p.finalizedBlock, p.readAt);
  if (executorGasUIDigest(base) !== digest || p.reviewDigest !== r.digest || p.runtimeDigest !== r.runtimeDigest || p.gasPolicyDigest !== r.gasPolicyDigest
    || p.profileRevision !== r.profileRevision || p.ownerBalanceWei !== r.ownerBalanceWei || p.executorBalanceWei !== r.executorBalanceWei
    || p.shortfallWei !== r.shortfallWei || p.sourceNonce !== r.sourceNonce || p.sourcePendingNonce !== r.sourcePendingNonce
    || p.readAt < r.issuedAt || p.expiresAt <= p.readAt || p.expiresAt > p.readAt + 15 || p.expiresAt > r.expiresAt
    || p.expiresAt > p.latestBlock.timestamp + 15) fail();
  return p;
}
function checkedAttempt(value: unknown, owner: string, executor: string): ExecutorGasAttemptView {
  const a = attemptSchema.parse(value); owners(a.owner, a.executor, owner, executor);
  if (a.expiresAt <= a.issuedAt || a.expiresAt > a.issuedAt + 15
    || (['reserved', 'owner-rejected', 'owner-cancelled-unsent'].includes(a.status) && a.transactionHash !== null)
    || (['hash-recorded', 'confirmed', 'reverted'].includes(a.status) && a.transactionHash === null)
    || (a.status === 'owner-cancelled-unsent' ? !a.unsentAttestationProof : a.unsentAttestationProof !== undefined)) fail();
  if (a.status === 'confirmed' || a.status === 'reverted') {
    const r = a.resolution;
    if (!r || r.outcome !== a.status || r.transactionHash !== a.transactionHash || !same(r.owner, owner) || !same(r.executor, executor)
      || (a.status === 'reverted' ? r.valueWei !== '0' : BigInt(r.valueWei) <= 0n)
      || BigInt(r.actualGasWei) !== BigInt(r.gasUsed) * BigInt(r.effectiveGasPriceWei)
      || BigInt(r.receiptBlock.number) > BigInt(r.finalizedBlock.number) || r.receiptBlock.timestamp > r.finalizedBlock.timestamp) fail();
  } else if (a.resolution !== null) fail();
  return a;
}
function checkedFence(value: unknown, owner: string, executor: string): ExecutorGasFence {
  const f = fenceSchema.parse(value);
  if (f.active) { checkedAttempt(f.active, owner, executor); if (!['reserved', 'hash-recorded', 'unknown'].includes(f.active.status)) fail(); }
  if (f.last) checkedAttempt(f.last, owner, executor);
  if (f.blocked !== !!f.active) fail(); return f;
}
export function parseExecutorGasReviewUI(value: unknown, owner: string, expectedExecutor: string): (ExecutorGasAudit & { fence: ExecutorGasFence }) | null {
  try {
    const v = z.object({ version: z.literal(1), chainId: z.literal(100), owner: address, executor: address,
      status: z.enum(['reviewable', 'funded', 'blocked']), readAt: time, expiresAt: time, review: z.unknown().nullable(), freshProof: z.unknown().nullable(),
      blockers: z.array(z.string().min(1).max(200)).max(32), ownerReviewAllowed: z.boolean(), executionApproved: z.literal(false), fence: z.unknown() }).parse(clone(value));
    owners(v.owner, v.executor, owner, expectedExecutor);
    if (v.expiresAt < v.readAt) return null;
    const r = v.review === null ? null : checkedReview(v.review, owner, expectedExecutor);
    const p = v.freshProof === null ? null : r ? checkedProof(v.freshProof, r) : fail(), f = checkedFence(v.fence, owner, expectedExecutor);
    if (v.ownerReviewAllowed && (v.status !== 'reviewable' || !r || !p || f.blocked || v.blockers.length || BigInt(r.shortfallWei) <= 0n
      || v.readAt !== p.readAt || v.expiresAt !== r.expiresAt)) return null;
    return { ...v, review: r, freshProof: p, fence: f };
  } catch { return null; }
}
export function parseExecutorGasReservationUI(value: unknown, owner: string, expectedExecutor: string): ExecutorGasReservation | null {
  try {
    const v = z.object({ version: z.literal(1), attempt: attemptSchema, review: z.unknown(), freshProof: z.unknown(), transaction }).parse(clone(value));
    const r = checkedReview(v.review, owner, expectedExecutor), p = checkedProof(v.freshProof, r), a = checkedAttempt(v.attempt, owner, expectedExecutor);
    if (a.status !== 'reserved' || a.profileRevision !== r.profileRevision || a.runtimeDigest !== r.runtimeDigest || a.reviewDigest !== r.digest
      || a.proofDigest !== p.digest || a.issuedAt !== p.readAt || a.expiresAt !== p.expiresAt || BigInt(r.shortfallWei) <= 0n
      || executorGasUIDigest(v.transaction) !== executorGasUIDigest(r.transaction)) return null;
    const snapshot = { id: a.id, owner: a.owner, executor: a.executor, profileRevision: a.profileRevision, runtimeDigest: a.runtimeDigest,
      reviewDigest: a.reviewDigest, proofDigest: a.proofDigest, issuedAt: a.issuedAt, expiresAt: a.expiresAt, review: r, freshProof: p, transaction: r.transaction };
    if (executorGasUIDigest(snapshot) !== a.snapshotDigest) return null;
    return { version: 1, attempt: a, review: r, freshProof: p, transaction: r.transaction };
  } catch { return null; }
}
export function assertExecutorGasReservationFresh(reservation: ExecutorGasReservation, now = Math.floor(Date.now() / 1000)) {
  if (!Number.isSafeInteger(now) || now < reservation.freshProof.readAt || now >= reservation.freshProof.expiresAt
    || now >= reservation.attempt.expiresAt || now >= reservation.review.expiresAt) throw new Error('wallet_executor_gas_stale');
}
export function parseExecutorGasAttemptResultUI(value: unknown, owner: string, expectedExecutor: string): ExecutorGasAttemptResultUI | null {
  try {
    const v = z.object({ attempt: z.unknown().optional(), fence: z.unknown() }).parse(clone(value));
    const f = checkedFence(v.fence, owner, expectedExecutor), a = v.attempt == null ? null : checkedAttempt(v.attempt, owner, expectedExecutor);
    if (a && (['reserved', 'hash-recorded', 'unknown'].includes(a.status) ? f.active?.id !== a.id : f.active?.id === a.id)) return null;
    return { attempt: a, fence: f };
  } catch { return null; }
}

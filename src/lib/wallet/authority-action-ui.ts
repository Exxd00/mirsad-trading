import { getAddress, keccak256, stringToHex, type Hex } from 'viem';
import { z } from 'zod';
import type { AuthorityCloseReview, AuthorityReview } from './authority';
import type { AuthorityActionAttemptView, AuthorityActionFence, AuthorityActionPayload, AuthorityActionPhase,
  AuthorityActionReservation } from './authority-action-attempts';

export type { AuthorityActionReservation, AuthorityActionPhase, AuthorityActionFence, AuthorityActionAttemptView };
const fail = (): never => { throw new Error('wallet_authority_action_invalid'); };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function authorityActionUIDigest(value: unknown): Hex {
  return keccak256(stringToHex(canonical(value)));
}
const clone = (v: unknown): unknown => {
  const json = JSON.stringify(v); if (!json || json.length > 250000) return fail(); return JSON.parse(json) as unknown;
};
const stamp = z.number().int().nonnegative().max(0xffffffff);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/).transform(v => v as Hex);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(v => getAddress(v.toLowerCase()));
const chain = z.union([z.literal(1), z.literal(100)]);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const batch = z.string().regex(/^0x[0-9a-fA-F]{1,256}$/);
const resolution = z.object({ outcome: z.enum(['confirmed', 'reverted']), transactionHashes: z.array(hash).min(1).max(64),
  evidenceDigest: hash, resolvedAt: stamp }).strict();
const attemptSchema = z.object({ id: z.uuid(), accountId: z.literal('metamask-strategy-v1'), owner: address, chainId: chain,
  reviewId: z.uuid(), reviewDigest: hash, profileRevision: integer.refine(v => v > 0), authorityRevision: integer.refine(v => v > 0),
  phase: z.enum(['deploy', 'bootstrap', 'close']), closeDigest: hash.nullable(), payloadDigest: hash, snapshotDigest: hash,
  ownerPendingNonce: integer, sourceBlock: z.object({ number: z.string().regex(/^(0|[1-9][0-9]{0,19})$/), hash, timestamp: stamp }).strict(),
  issuedAt: stamp, expiresAt: stamp, status: z.enum(['reserved', 'references-recorded', 'unknown', 'owner-rejected', 'owner-cancelled-unsent', 'confirmed', 'reverted']),
  transactionHashes: z.array(hash).max(64), callBatchIds: z.array(batch).max(1), resolution: resolution.nullable() }).strict();
function checkedAttempt(value: unknown): AuthorityActionAttemptView {
  const a = attemptSchema.parse(value);
  if (a.issuedAt >= a.expiresAt || a.sourceBlock.timestamp > a.issuedAt || a.issuedAt - a.sourceBlock.timestamp >= 60
    || (a.phase === 'close') !== !!a.closeDigest || new Set(a.transactionHashes).size !== a.transactionHashes.length
    || (a.phase === 'deploy' && (a.callBatchIds.length || a.transactionHashes.length > 1))) return fail();
  if (a.status === 'confirmed' || a.status === 'reverted') {
    if (!a.resolution || a.resolution.outcome !== a.status || a.resolution.resolvedAt < a.issuedAt
      || a.resolution.transactionHashes.some(h => !a.transactionHashes.includes(h))) return fail();
  } else if (a.resolution) return fail();
  if (['reserved', 'owner-rejected', 'owner-cancelled-unsent'].includes(a.status) && (a.transactionHashes.length || a.callBatchIds.length)) return fail();
  if (a.status === 'references-recorded' && !a.transactionHashes.length && !a.callBatchIds.length) return fail();
  return a;
}
export function parseAuthorityActionFenceUI(value: unknown): AuthorityActionFence | null {
  try {
    const raw = z.object({ blocked: z.boolean(), active: z.unknown().nullable(), last: z.unknown().nullable() }).strict().parse(clone(value));
    const active = raw.active ? checkedAttempt(raw.active) : null, last = raw.last ? checkedAttempt(raw.last) : null;
    if (raw.blocked !== !!active || (active && !['reserved', 'references-recorded', 'unknown'].includes(active.status))
      || (active && (!last || last.id !== active.id || authorityActionUIDigest(last) !== authorityActionUIDigest(active)))) return null;
    return { blocked: raw.blocked, active, last };
  } catch { return null; }
}
export function parseAuthorityActionStateUI(value: unknown): { actionFence: AuthorityActionFence; actionAttempt: AuthorityActionAttemptView | null } | null {
  try {
    const source = value as { actionFence?: unknown; actionAttempt?: unknown };
    const raw = clone({ actionFence: source?.actionFence, ...(source?.actionAttempt ? { actionAttempt: source.actionAttempt } : {}) }) as typeof source;
    const actionFence = parseAuthorityActionFenceUI(raw.actionFence);
    if (!actionFence) return null;
    const actionAttempt = raw.actionAttempt ? checkedAttempt(raw.actionAttempt) : null;
    if (actionAttempt && ![actionFence.active, actionFence.last].some(a => a?.id === actionAttempt.id
      && authorityActionUIDigest(a) === authorityActionUIDigest(actionAttempt))) return null;
    return { actionFence, actionAttempt };
  } catch { return null; }
}
function payloadFor(review: AuthorityReview, phase: AuthorityActionPhase, close: AuthorityCloseReview | null): AuthorityActionPayload {
  if (phase === 'deploy') {
    if (!review.deploymentStep) return fail();
    return { kind: 'transaction', transaction: { chainId: review.chainId, from: getAddress(review.owner), ...review.deploymentStep.transaction } };
  }
  return { kind: 'calls', chainId: review.chainId, from: getAddress(review.owner), atomicRequired: true,
    calls: structuredClone(phase === 'close' ? close!.calls : review.calls) };
}
export function authorityActionUISnapshot(r: AuthorityActionReservation): Hex {
  const a = r.attempt;
  return authorityActionUIDigest({ version: 1, id: a.id, accountId: a.accountId, owner: a.owner, chainId: a.chainId,
    reviewId: a.reviewId, reviewDigest: a.reviewDigest, profileRevision: a.profileRevision, authorityRevision: a.authorityRevision,
    phase: a.phase, closeDigest: a.closeDigest, payloadDigest: a.payloadDigest, ownerPendingNonce: a.ownerPendingNonce, sourceBlock: a.sourceBlock,
    issuedAt: a.issuedAt, expiresAt: a.expiresAt, review: r.review, close: r.close, payload: r.payload });
}
/** Snapshots both inputs before loading the SDK. No browser calldata is trusted. */
export async function parseAuthorityActionReservationUI(value: unknown, inputReview: AuthorityReview, phase: AuthorityActionPhase,
  inputClose?: AuthorityCloseReview, expectedRevision?: number): Promise<AuthorityActionReservation | null> {
  try {
    const candidate = (value as { actionReservation?: unknown } | null)?.actionReservation ?? value;
    const envelope = clone(candidate), expected = clone(inputReview), expectedClose = inputClose ? clone(inputClose) : null;
    const raw = z.object({ version: z.literal(1), attempt: z.unknown(), review: z.unknown(), close: z.unknown().nullable(), payload: z.unknown() }).strict()
      .parse(envelope);
    const { parseAuthorityReview, createAuthorityCloseReview, authorityDigest } = await import('./authority');
    const review = parseAuthorityReview(raw.review), wanted = parseAuthorityReview(expected), a = checkedAttempt(raw.attempt);
    const close = raw.close as AuthorityCloseReview | null;
    if (close && authorityDigest(createAuthorityCloseReview(review, close, close.createdAt)) !== authorityDigest(close)) return null;
    if (authorityDigest(review) !== authorityDigest(wanted) || authorityDigest(close) !== authorityDigest(expectedClose)
      || a.status !== 'reserved' || a.phase !== phase || a.reviewId !== review.id || a.reviewDigest !== review.digest
      || a.owner !== getAddress(review.owner) || a.chainId !== review.chainId || a.profileRevision !== review.profileRevision
      || (expectedRevision !== undefined && a.authorityRevision !== expectedRevision) || (phase === 'close') !== !!close
      || a.closeDigest !== (close?.digest ?? null) || a.expiresAt !== (close?.reviewExpiresAt ?? review.reviewExpiresAt)) return null;
    const payload = payloadFor(review, phase, close);
    if (authorityDigest(payload) !== authorityDigest(raw.payload) || a.payloadDigest !== authorityDigest(payload)) return null;
    const result: AuthorityActionReservation = { version: 1, attempt: a, review, close, payload };
    return a.snapshotDigest === authorityActionUISnapshot(result) ? result : null;
  } catch { return null; }
}
export function assertAuthorityActionReservationFresh(r: AuthorityActionReservation, now = Math.floor(Date.now() / 1000)) {
  if (!Number.isSafeInteger(now) || now < r.attempt.issuedAt || now >= r.attempt.expiresAt) throw new Error('wallet_authority_action_expired');
}

type OwnerResult = { kind: 'transaction' | 'batch' | 'signature'; value: string };
/** The metadata request deliberately outlives the React view. A failed record
 * leaves the pre-prompt durable fence blocked; it never permits a second send. */
export async function runReservedAuthorityAction(input: { review: AuthorityReview; close?: AuthorityCloseReview; phase: AuthorityActionPhase;
  expectedRevision: number; post: (body: Record<string, unknown>) => Promise<unknown>;
  ownerAction: (review: AuthorityReview, phase: AuthorityActionPhase, close: AuthorityCloseReview | undefined, reservation: AuthorityActionReservation) => Promise<OwnerResult>;
  isCurrent: () => boolean; isUnsent: (error: unknown) => boolean; isRejected: (error: unknown) => boolean;
  onReference?: (value: string) => void }): Promise<OwnerResult> {
  const review = structuredClone(input.review), close = input.close ? structuredClone(input.close) : undefined;
  const raw = await input.post({ action: 'reserve-action', id: review.id, digest: review.digest, expectedRevision: input.expectedRevision,
    phase: input.phase, ...(close ? { closeDigest: close.digest } : {}) });
  const r = await parseAuthorityActionReservationUI(raw, review, input.phase, close, input.expectedRevision);
  if (!r) throw new Error('wallet_authority_action_reservation_invalid');
  const identity = { attemptId: r.attempt.id, snapshotDigest: r.attempt.snapshotDigest };
  let result: OwnerResult;
  try {
    if (!input.isCurrent()) {
      await input.post({ action: 'cancel-unsent-action', ...identity, requestIssued: false });
      throw new Error('wallet_authority_action_view_changed');
    }
    result = await input.ownerAction(review, input.phase, close, r);
  } catch (error) {
    const action = input.isUnsent(error) ? 'cancel-unsent-action' : input.isRejected(error) ? 'reject-action' : 'unknown-action';
    // Even a lost response must not trigger a wallet request. Terminal state
    // changes here are based only on the locally branded pre-send/4001 result.
    if (input.isCurrent() || !(error instanceof Error && error.message === 'wallet_authority_action_view_changed')) {
      await input.post({ action, ...identity, ...(action === 'cancel-unsent-action' ? { requestIssued: false } : action === 'reject-action' ? { code: 4001 } : {}) }).catch(() => undefined);
    }
    throw error;
  }
  if (result.kind !== (input.phase === 'deploy' ? 'transaction' : 'batch')
    || !(result.kind === 'transaction' ? /^0x[0-9a-fA-F]{64}$/ : /^0x[0-9a-fA-F]{1,256}$/).test(result.value)) {
    await input.post({ action: 'unknown-action', ...identity }).catch(() => undefined); return fail();
  }
  input.onReference?.(result.value);
  await input.post({ action: 'record-action', ...identity,
    ...(result.kind === 'transaction' ? { transactionHashes: [result.value] } : { callBatchIds: [result.value] }) });
  return result;
}

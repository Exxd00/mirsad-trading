import 'server-only';
import type { Address, Hex } from 'viem';
import type { AuthorityBlock, AuthorityCall, AuthorityCloseReview, AuthorityReview } from './authority';
import { randomUUID } from 'node:crypto';
import { getAddress } from 'viem';
import { z } from 'zod';
import { query, transaction, type SqlExecutor } from '../db';
import { CONFIG } from '../execution/v1/model';
import { AuthorityError, authorityDigest, authorityNow, createAuthorityCloseReview, parseAuthorityReview } from './authority';
import { loadAuthority, saveAuthority } from './authority-store';
import { loadStrategyProfile } from './strategy-profile';
import { loadCowRuntime, productionCowClient, runtimeMatchesProfile } from './cow-runtime-config';
import { createCowPolicyDraft } from './cow-policy';
import { readExecutorGasFence } from './gnosis-executor-gas-attempts';
import { AUTHORITY_ACTION_PREFIX, AUTHORITY_ACTION_FENCE_KEY, assertAuthorityActionIdle, authorityActionFenceState } from './authority-action-fence';

export type AuthorityActionPhase = 'deploy' | 'bootstrap' | 'close';
export type AuthorityActionStatus = 'reserved' | 'references-recorded' | 'unknown' | 'owner-rejected' | 'owner-cancelled-unsent' | 'confirmed' | 'reverted';
export type AuthorityActionPayload =
  | { kind: 'transaction'; transaction: { chainId: 1 | 100; from: Address; data: Hex; value: '0x0'; nonce: Hex } }
  | { kind: 'calls'; chainId: 1 | 100; from: Address; atomicRequired: true; calls: AuthorityCall[] };
export type AuthorityActionResolution = { outcome: 'confirmed' | 'reverted'; transactionHashes: Hex[];
  evidenceDigest: Hex; resolvedAt: number };
export type AuthorityActionAttemptView = { id: string; accountId: string; owner: Address; chainId: 1 | 100;
  reviewId: string; reviewDigest: Hex; profileRevision: number; authorityRevision: number; phase: AuthorityActionPhase; closeDigest: Hex | null;
  payloadDigest: Hex; snapshotDigest: Hex; issuedAt: number; expiresAt: number; status: AuthorityActionStatus;
  ownerPendingNonce: number; sourceBlock: AuthorityBlock;
  transactionHashes: Hex[]; callBatchIds: string[]; resolution: AuthorityActionResolution | null };
export type AuthorityActionFence = { blocked: boolean; active: AuthorityActionAttemptView | null; last: AuthorityActionAttemptView | null };
export type AuthorityActionReservation = { version: 1; attempt: AuthorityActionAttemptView; review: AuthorityReview;
  close: AuthorityCloseReview | null; payload: AuthorityActionPayload };
export type AuthorityActionAttemptResult = { attempt: AuthorityActionAttemptView; actionFence: AuthorityActionFence };
type Stored = AuthorityActionReservation;
type Dependencies = { read?: SqlExecutor['query']; transact?: typeof transaction; clock?: () => number;
  baseline?: (review: AuthorityReview) => Promise<{ ownerPendingNonce: number; sourceBlock: AuthorityBlock }>;
  resolve?: typeof import('./authority-action-receipt')['resolveAuthorityActionReceipt'] };
const stamp = z.number().int().nonnegative().max(0xffffffff), hash = z.string().regex(/^0x[0-9a-f]{64}$/).transform(v => v as Hex);
const viewSchema = z.object({ id: z.uuid(), accountId: z.literal(CONFIG.accountId), owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  chainId: z.union([z.literal(1), z.literal(100)]), reviewId: z.uuid(), reviewDigest: hash, profileRevision: z.number().int().positive(),
  authorityRevision: z.number().int().positive(), phase: z.enum(['deploy', 'bootstrap', 'close']), closeDigest: hash.nullable(), payloadDigest: hash,
  snapshotDigest: hash, issuedAt: stamp, expiresAt: stamp, ownerPendingNonce: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sourceBlock: z.object({ number: z.string().regex(/^(0|[1-9][0-9]{0,19})$/), hash, timestamp: stamp }).strict(),
  status: z.enum(['reserved', 'references-recorded', 'unknown', 'owner-rejected', 'owner-cancelled-unsent', 'confirmed', 'reverted']),
  transactionHashes: z.array(hash).max(64), callBatchIds: z.array(z.string().regex(/^0x[0-9a-fA-F]{1,256}$/)).max(1), resolution: z.unknown().nullable() }).strict();
const resolutionSchema = z.object({ outcome: z.enum(['confirmed', 'reverted']), transactionHashes: z.array(hash).min(1).max(64), evidenceDigest: hash, resolvedAt: stamp }).strict();
const fail = (code = 'wallet_authority_action_stored_invalid'): never => { throw new AuthorityError(code); };
const time = (d: Dependencies) => authorityNow((d.clock ?? (() => Math.floor(Date.now() / 1000)))());
const terminal = (a: AuthorityActionAttemptView) => ['owner-rejected', 'owner-cancelled-unsent', 'confirmed', 'reverted'].includes(a.status);
const sameHashes = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(h => b.includes(h));
export function authorityActionPayload(review: AuthorityReview, phase: AuthorityActionPhase, close: AuthorityCloseReview | null): AuthorityActionPayload {
  if (phase === 'deploy') {
    if (!review.deploymentStep) return fail('wallet_authority_action_invalid');
    return { kind: 'transaction', transaction: { chainId: review.chainId, from: getAddress(review.owner), ...review.deploymentStep.transaction } };
  }
  return { kind: 'calls', chainId: review.chainId, from: getAddress(review.owner), atomicRequired: true,
    calls: structuredClone(phase === 'close' ? close?.calls ?? [] : review.calls) };
}
export function authorityActionSnapshot(r: AuthorityActionReservation): Hex {
  const a = r.attempt;
  return authorityDigest({ version: 1, id: a.id, accountId: a.accountId, owner: a.owner, chainId: a.chainId, reviewId: a.reviewId,
    reviewDigest: a.reviewDigest, profileRevision: a.profileRevision, authorityRevision: a.authorityRevision, phase: a.phase, closeDigest: a.closeDigest,
    payloadDigest: a.payloadDigest, ownerPendingNonce: a.ownerPendingNonce, sourceBlock: a.sourceBlock,
    issuedAt: a.issuedAt, expiresAt: a.expiresAt, review: r.review, close: r.close, payload: r.payload });
}
function parse(raw: unknown, id: string): Stored {
  try {
    const r = raw as Stored, a = viewSchema.parse(r?.attempt), review = parseAuthorityReview(r.review), close = r.close;
    if (close) {
      const rebuilt = createAuthorityCloseReview(review, close, close.createdAt);
      if (authorityDigest(rebuilt) !== authorityDigest(close)) return fail();
    }
    if (r.version !== 1 || a.id !== id || a.owner !== getAddress(review.owner) || a.chainId !== review.chainId || a.reviewId !== review.id
      || a.reviewDigest !== review.digest || a.profileRevision !== review.profileRevision || a.closeDigest !== (close?.digest ?? null)
      || (a.phase === 'close') !== !!close || a.expiresAt !== (close?.reviewExpiresAt ?? review.reviewExpiresAt) || a.issuedAt >= a.expiresAt
      || a.payloadDigest !== authorityDigest(r.payload) || authorityDigest(r.payload) !== authorityDigest(authorityActionPayload(review, a.phase, close))
      || a.snapshotDigest !== authorityActionSnapshot(r) || (a.phase === 'deploy' && (a.callBatchIds.length || a.transactionHashes.length > 1))) return fail();
    const resolution = a.resolution === null ? null : resolutionSchema.parse(a.resolution);
    if (['confirmed', 'reverted'].includes(a.status)) {
      if (!resolution || resolution.outcome !== a.status || !resolution.transactionHashes.length || !sameHashes(resolution.transactionHashes, a.transactionHashes)
        || !hash.safeParse(resolution.evidenceDigest).success || !stamp.safeParse(resolution.resolvedAt).success) return fail();
    } else if (resolution !== null) return fail();
    if (a.status === 'references-recorded' && !a.transactionHashes.length && !a.callBatchIds.length) return fail();
    if (['owner-rejected', 'owner-cancelled-unsent'].includes(a.status) && (a.transactionHashes.length || a.callBatchIds.length)) return fail();
    return { version: 1, attempt: { ...a, owner: getAddress(a.owner), resolution }, review, close, payload: r.payload };
  } catch { return fail(); }
}
const attemptKey = (id: string) => AUTHORITY_ACTION_PREFIX + 'attempt:' + id;
async function load(tx: SqlExecutor, id: string): Promise<Stored> {
  if (!z.uuid().safeParse(id).success) return fail('wallet_authority_action_invalid');
  const r = await tx.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [attemptKey(id)]);
  if (r.rowCount !== 1) return fail(); return parse(r.rows[0].value, id);
}
async function save(tx: SqlExecutor, key: string, value: unknown) {
  await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()', [key, JSON.stringify(value)]);
}
async function fence(tx: SqlExecutor): Promise<AuthorityActionFence> {
  const s = await authorityActionFenceState(tx), active = s.activeId ? (await load(tx, s.activeId)).attempt : null, last = s.lastId ? (await load(tx, s.lastId)).attempt : null;
  if (active && terminal(active)) return fail(); return { blocked: !!active, active, last };
}
export async function readAuthorityActionFence(tx: SqlExecutor = { query }): Promise<AuthorityActionFence> { return fence(tx); }
async function baseline(review: AuthorityReview) {
  try {
  const c = productionCowClient(review.chainId), [chainId, b, nonce] = await Promise.all([c.getChainId(), c.getBlock(), c.getTransactionCount({ address: getAddress(review.owner), blockTag: 'pending' })]);
  if (chainId !== review.chainId || b.number === null || !b.hash || !Number.isSafeInteger(nonce)) return fail('wallet_authority_verification_unavailable');
  const again = await c.getBlock({ blockNumber: b.number });
  if (again.hash !== b.hash) return fail('wallet_authority_verification_unavailable');
  return { ownerPendingNonce: nonce, sourceBlock: { number: b.number.toString(), hash: b.hash, timestamp: Number(b.timestamp) } };
  } catch { return fail('wallet_authority_verification_unavailable'); }
}
async function context(tx: SqlExecutor, input: { id: string; digest: Hex; expectedRevision: number; phase: AuthorityActionPhase; closeDigest?: Hex }, now: number) {
  const record = await loadAuthority(tx), p = await loadStrategyProfile(tx, now), config = await loadCowRuntime(tx);
  if (!record || record.review.id !== input.id || record.review.digest !== input.digest || record.revision !== input.expectedRevision) return fail('wallet_authority_revision_conflict');
  const review = record.review, close = input.phase === 'close' ? record.close : null;
  if (!p || !config || !runtimeMatchesProfile(config, p) || p.revision !== review.profileRevision || p.profile.owner !== review.owner.toLowerCase()
    || p.profile.chainId !== review.chainId || createCowPolicyDraft(config.terms, { manager: config.manager, enforcer: config.enforcer }).delegationHash !== review.delegation.delegationHash) return fail('wallet_authority_profile_changed');
  if (input.phase === 'close') {
    if (record.state !== 'closing' || !close || close.digest !== input.closeDigest || close.blockers.length) return fail('wallet_authority_close_invalid');
  } else if (['verified', 'closed', 'closing', 'signature-pending'].includes(record.state) || input.closeDigest) return fail('wallet_authority_state_invalid');
  if (now >= (close?.reviewExpiresAt ?? review.reviewExpiresAt)) return fail('wallet_authority_review_expired');
  if (input.phase === 'deploy' && (!review.deploymentStep || review.deploymentStep.blocker || !review.deploymentStep.gasEstimate)
    || input.phase === 'bootstrap' && (review.blockers.length || review.deploymentStep || !review.calls.length)) return fail('wallet_authority_action_invalid');
  return { record, review, close, payload: authorityActionPayload(review, input.phase, close), profile: p, config };
}
export async function reserveAuthorityAction(input: { id: string; digest: Hex; expectedRevision: number; phase: AuthorityActionPhase; closeDigest?: Hex }, d: Dependencies = {}): Promise<AuthorityActionReservation> {
  const tx = { query: d.read ?? query }; await assertAuthorityActionIdle(tx);
  const before = await context(tx, input, time(d)), point = await (d.baseline ?? baseline)(before.review);
  return (d.transact ?? transaction)(async t => {
    const s = await authorityActionFenceState(t, true); if (s.activeId) return fail('wallet_authority_action_pending');
    if (before.review.chainId === 100 && (await readExecutorGasFence(before.review.owner, { read: t.query })).blocked) return fail('wallet_authority_executor_gas_pending');
    const now = time(d), current = await context(t, input, now);
    if (authorityDigest(current.config) !== authorityDigest(before.config) || authorityDigest(current.profile) !== authorityDigest(before.profile)
      || !stamp.safeParse(point.sourceBlock.timestamp).success || point.sourceBlock.timestamp > now || now - point.sourceBlock.timestamp >= 60
      || !Number.isSafeInteger(point.ownerPendingNonce) || point.ownerPendingNonce < 0) return fail('wallet_authority_verification_unavailable');
    const a: AuthorityActionAttemptView = { id: randomUUID(), accountId: CONFIG.accountId, owner: getAddress(current.review.owner), chainId: current.review.chainId,
      reviewId: current.review.id, reviewDigest: current.review.digest, profileRevision: current.review.profileRevision, authorityRevision: current.record.revision,
      phase: input.phase, closeDigest: current.close?.digest ?? null, payloadDigest: authorityDigest(current.payload), snapshotDigest: ('0x' + '0'.repeat(64)) as Hex,
      issuedAt: now, expiresAt: current.close?.reviewExpiresAt ?? current.review.reviewExpiresAt, status: 'reserved',
      ownerPendingNonce: point.ownerPendingNonce, sourceBlock: point.sourceBlock, transactionHashes: [], callBatchIds: [], resolution: null };
    const r: Stored = { version: 1, attempt: a, review: current.review, close: current.close, payload: current.payload }; a.snapshotDigest = authorityActionSnapshot(r);
    await save(t, attemptKey(a.id), parse(r, a.id)); await save(t, AUTHORITY_ACTION_FENCE_KEY, { ...s, activeId: a.id, lastId: a.id }); return r;
  });
}
async function update(id: string, digest: Hex, d: Dependencies, work: (r: Stored, tx: SqlExecutor) => Promise<void>): Promise<AuthorityActionAttemptResult> {
  return (d.transact ?? transaction)(async tx => {
    const s = await authorityActionFenceState(tx, true), r = await load(tx, id);
    if (r.attempt.snapshotDigest !== digest || (s.activeId !== id && !terminal(r.attempt))) return fail('wallet_authority_action_changed');
    await work(r, tx); await save(tx, attemptKey(id), parse(r, id));
    if (terminal(r.attempt) && s.activeId === id) await save(tx, AUTHORITY_ACTION_FENCE_KEY, { ...s, activeId: null, lastId: id });
    return { attempt: r.attempt, actionFence: await fence(tx) };
  });
}
export async function recordAuthorityActionReferences(input: { attemptId: string; snapshotDigest: Hex; transactionHashes?: Hex[]; callBatchIds?: string[] }, d: Dependencies = {}) {
  return update(input.attemptId, input.snapshotDigest, d, async (r, tx) => {
    const a = r.attempt, hashes = [...new Set([...(a.transactionHashes ?? []), ...(input.transactionHashes ?? []).map(h => h.toLowerCase() as Hex)])], batches = [...new Set([...a.callBatchIds, ...(input.callBatchIds ?? [])])];
    if (terminal(a)) {
      if (hashes.every(h => a.transactionHashes.includes(h)) && batches.every(h => a.callBatchIds.includes(h))) return;
      return fail('wallet_authority_action_changed');
    }
    if (hashes.some(h => !hash.safeParse(h).success) || hashes.length > (a.phase === 'deploy' ? 1 : 64) || batches.length > (a.phase === 'deploy' ? 0 : 1)
      || batches.some(s => !/^0x[0-9a-fA-F]{1,256}$/.test(s)) || (!hashes.length && !batches.length)) return fail('wallet_authority_action_invalid');
    a.transactionHashes = hashes; a.callBatchIds = batches; a.status = 'references-recorded';
    const current = await loadAuthority(tx);
    if (current && current.review.id === a.reviewId && current.review.digest === a.reviewDigest && !['closed', 'verified'].includes(current.state)) {
      const wantedHashes = [...new Set([...(current.candidateTransactionHashes ?? []), ...hashes])], wantedBatches = [...new Set([...(current.candidateCallBatchIds ?? []), ...batches])];
      if (authorityDigest(wantedHashes) !== authorityDigest(current.candidateTransactionHashes ?? []) || authorityDigest(wantedBatches) !== authorityDigest(current.candidateCallBatchIds ?? []))
        await saveAuthority(tx, { ...current, state: current.state === 'closing' ? 'closing' : 'owner-actions-pending', candidateTransactionHashes: wantedHashes,
          candidateCallBatchIds: wantedBatches, updatedAt: time(d) }, current.revision, a.id);
    }
    await tx.query('INSERT INTO audit_events(event,detail) VALUES($1,$2::jsonb)', ['wallet.authority.action.references', JSON.stringify({ attemptId: a.id,
      reviewId: a.reviewId, digest: a.reviewDigest, transactionHashes: hashes, callBatchIds: batches, at: time(d), verification: 'unverified-candidate' })]);
  });
}
export async function markAuthorityActionUnknown(id: string, digest: Hex, d: Dependencies = {}) {
  return update(id, digest, d, async r => { if (!terminal(r.attempt)) r.attempt.status = 'unknown'; });
}
export async function rejectAuthorityAction(id: string, digest: Hex, code: number, d: Dependencies = {}) {
  if (code !== 4001) return fail('wallet_authority_action_invalid');
  return update(id, digest, d, async (r, tx) => {
    if (r.attempt.transactionHashes.length || r.attempt.callBatchIds.length || terminal(r.attempt)) return fail('wallet_authority_action_changed');
    r.attempt.status = 'owner-rejected'; await tx.query('INSERT INTO audit_events(event,detail) VALUES($1,$2::jsonb)', ['wallet.authority.action.owner_rejected', JSON.stringify({ attemptId: id, code, at: time(d) })]);
  });
}
export async function cancelAuthorityActionUnsent(id: string, digest: Hex, requestIssued: false, d: Dependencies = {}) {
  if (requestIssued !== false) return fail('wallet_authority_action_invalid');
  return update(id, digest, d, async (r, tx) => {
    if (r.attempt.status !== 'reserved' || r.attempt.transactionHashes.length || r.attempt.callBatchIds.length) return fail('wallet_authority_action_changed');
    r.attempt.status = 'owner-cancelled-unsent'; await tx.query('INSERT INTO audit_events(event,detail) VALUES($1,$2::jsonb)', ['wallet.authority.action.owner_attested_unsent', JSON.stringify({ attemptId: id, snapshotDigest: digest, requestIssued: false, at: time(d) })]);
  });
}
export async function resolveAuthorityAction(id: string, digest: Hex, transactionHashes: Hex[] | undefined, d: Dependencies = {}) {
  if (transactionHashes?.length) await recordAuthorityActionReferences({ attemptId: id, snapshotDigest: digest, transactionHashes }, d);
  const r = await load({ query: d.read ?? query }, id);
  if (r.attempt.snapshotDigest !== digest) return fail('wallet_authority_action_changed');
  if (terminal(r.attempt) || !r.attempt.transactionHashes.length) return { attempt: r.attempt, actionFence: await readAuthorityActionFence({ query: d.read ?? query }) };
  const resolve = d.resolve ?? (await import('./authority-action-receipt')).resolveAuthorityActionReceipt;
  const proof = await resolve(r, r.attempt.transactionHashes, { clock: d.clock });
  if (!proof) return { attempt: r.attempt, actionFence: await readAuthorityActionFence({ query: d.read ?? query }) };
  if (!sameHashes(proof.resolution.transactionHashes, r.attempt.transactionHashes) || proof.fees.length !== proof.resolution.transactionHashes.length
    || proof.fees.some(f => f.chainId !== r.attempt.chainId || f.owner.toLowerCase() !== r.attempt.owner.toLowerCase()
      || f.authorityDigest !== r.review.digest || !proof.resolution.transactionHashes.includes(f.transactionHash)
      || BigInt(f.gasUsed) * BigInt(f.effectiveGasPriceWei) !== BigInt(f.actualGasWei))) return fail('wallet_authority_action_receipt_invalid');
  return update(id, digest, d, async (saved, tx) => {
    if (terminal(saved.attempt) || !sameHashes(proof.resolution.transactionHashes, saved.attempt.transactionHashes)) return fail('wallet_authority_action_changed');
    saved.attempt.resolution = proof.resolution; saved.attempt.status = proof.resolution.outcome;
    for (const fee of proof.fees) await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',
      [`wallet:cow:v1:owner-setup-fee:${fee.chainId === 1 ? '' : `${fee.chainId}:`}${fee.owner.toLowerCase()}:${fee.transactionHash.toLowerCase()}`, JSON.stringify(fee)]);
    const current = await loadAuthority(tx);
    if (proof.resolution.outcome === 'reverted' && current?.review.id === saved.review.id && current.review.digest === saved.review.digest
      && !['verified', 'closed'].includes(current.state) && !current.signatureCiphertext) {
      // Reverted operations consumed nonce/gas but granted no authority. Keep
      // their complete history in this attempt/audit, not as future candidates.
      await saveAuthority(tx, { ...current, candidateTransactionHashes: (current.candidateTransactionHashes ?? []).filter(h => !saved.attempt.transactionHashes.includes(h)),
        candidateCallBatchIds: (current.candidateCallBatchIds ?? []).filter(h => !saved.attempt.callBatchIds.includes(h)), updatedAt: time(d) }, current.revision, id);
    }
    await tx.query('INSERT INTO audit_events(event,detail) VALUES($1,$2::jsonb)', ['wallet.authority.action.resolved', JSON.stringify({ attemptId: id,
      reviewId: saved.review.id, digest: saved.review.digest, resolution: proof.resolution, transactionHashes: saved.attempt.transactionHashes, callBatchIds: saved.attempt.callBatchIds })]);
  });
}

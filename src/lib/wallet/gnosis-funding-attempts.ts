import 'server-only';
import { randomUUID } from 'node:crypto';
import { getAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { query, transaction, type SqlExecutor } from '../db';
import { fundingDigest, GnosisFundingError, proveGnosisFundingNoSourceEffect, resolveGnosisFundingReceipt, verifyGnosisFundingReview, type GnosisFundingPrepared,
  type GnosisFundingFreshProof } from './gnosis-funding-service';
import type { GnosisFundingQuoteReview } from './gnosis-funding-quote';
import { GNOSIS_HISTORY_IDENTITY,GNOSIS_EMA_CACHE_PREFIX,GNOSIS_LEGACY_CACHE_PREFIX } from './gnosis-market';

export type GnosisFundingPhase = 'approve' | 'fund';
export type GnosisFundingAttemptStatus = 'reserved' | 'hash-recorded' | 'unknown' | 'owner-rejected' | 'owner-cancelled-unsent' | 'confirmed' | 'reverted';
export type GnosisFundingResolution = { transactionHash: Hex; receiptBlock: { number: string; hash: Hex; timestamp: number };
  finalizedBlock: { number: string; hash: Hex; timestamp: number }; sourceTokenOutflowRaw: string; evidenceDigest: Hex;
  destinationArrival: 'not-certified'; outcome: 'confirmed' | 'reverted' };
export type GnosisFundingAttemptView = { id: string; owner: Address; phase: GnosisFundingPhase; status: GnosisFundingAttemptStatus;
  reviewDigest: Hex; proofDigest: Hex; snapshotDigest: Hex; issuedAt: number; expiresAt: number; transactionHash: Hex | null;
  resolution: GnosisFundingResolution | null; unsentAttestationProof?: Hex };
export type GnosisFundingFence = { blocked: boolean; active: GnosisFundingAttemptView | null; fundCompleted: boolean;
  lastApproval: GnosisFundingAttemptView | null };
export type GnosisFundingReservation = { version: 1; attempt: GnosisFundingAttemptView; review: GnosisFundingQuoteReview;
  freshProof: GnosisFundingFreshProof; transaction: { chainId: 1; from: Address; to: Address; value: '0x0'; data: Hex } };
export type FundingResolutionInput = { phase: GnosisFundingPhase; owner: Address; transactionHash: Hex; review: GnosisFundingQuoteReview;
  freshProof: GnosisFundingFreshProof };
type Dependencies = { read?: SqlExecutor['query']; transact?: typeof transaction; clock?: () => number;
  verify?: typeof verifyGnosisFundingReview; resolve?: (input: FundingResolutionInput) => Promise<GnosisFundingResolution | null>;
  proveUnsent?: typeof proveGnosisFundingNoSourceEffect };
const PREFIX = 'wallet:gnosis:owner-funding:v1:';
const time = z.number().int().nonnegative().max(253402300799), digest = z.string().regex(/^0x[0-9a-f]{64}$/).transform(v => v as Hex);
const ownerSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(v => !/^0x0{40}$/i.test(v)).transform(v => getAddress(v.toLowerCase()));
const attemptSchema = z.object({ id: z.string().uuid(), owner: ownerSchema, phase: z.enum(['approve', 'fund']),
  status: z.enum(['reserved', 'hash-recorded', 'unknown', 'owner-rejected', 'owner-cancelled-unsent', 'confirmed', 'reverted']), reviewDigest: digest,
  proofDigest: digest, snapshotDigest: digest, issuedAt: time, expiresAt: time, transactionHash: digest.nullable(),
  reviewJson: z.string().max(150000), proofJson: z.string().max(10000), resolution: z.unknown().nullable(), unsentAttestationProof: digest.optional() }).strict();
type Attempt = Omit<z.infer<typeof attemptSchema>, 'resolution'> & { resolution: GnosisFundingResolution | null };
const stateSchema = z.object({ version: z.literal(1), owner: ownerSchema, activeId: z.string().uuid().nullable(),
  lastApprovalId: z.string().uuid().nullable(), completedFundId: z.string().uuid().nullable() }).strict();
type State = z.infer<typeof stateSchema>;
const artifactSchema = z.object({ version: z.literal(1), owner: ownerSchema, observedAt: time,
  reviewDigest: digest, proofDigest: digest, rawQuoteJson: z.string().max(131072), reviewJson: z.string().max(150000), proofJson: z.string().max(10000) }).strict();
const fail = (code = 'wallet_gnosis_funding_attempt_invalid'): never => { throw new GnosisFundingError(code); };
const address = (v: string): Address => { const p = ownerSchema.safeParse(v); return p.success ? p.data : fail('wallet_gnosis_funding_request_invalid'); };
const stateKey = (owner: Address) => `${PREFIX}${owner.toLowerCase()}:state`;
const artifactKey = (owner: Address) => `${PREFIX}${owner.toLowerCase()}:review`;
const attemptKey = (owner: Address, id: string) => `${PREFIX}${owner.toLowerCase()}:attempt:${id}`;
const decodeJson = <T>(value: string): T => { try { return JSON.parse(value) as T; } catch { return fail(); } };
function snapshot(a: Pick<Attempt, 'id' | 'owner' | 'phase' | 'reviewDigest' | 'proofDigest' | 'issuedAt' | 'expiresAt'>,
  review: GnosisFundingQuoteReview, proof: GnosisFundingFreshProof) {
  return fundingDigest({ id: a.id, owner: a.owner, phase: a.phase, reviewDigest: a.reviewDigest, proofDigest: a.proofDigest,
    issuedAt: a.issuedAt, expiresAt: a.expiresAt, review, freshProof: proof, transaction: a.phase === 'approve'
    ? { chainId: 1, from: a.owner, to: review.approval.token, value: '0x0', data: review.approval.data } : review.transaction });
}
function parsedAttempt(value: unknown, owner: Address, id: string): Attempt {
  try {
    const a = attemptSchema.parse(value), review = decodeJson<GnosisFundingQuoteReview>(a.reviewJson), proof = decodeJson<GnosisFundingFreshProof>(a.proofJson);
    const base = { id: a.id, owner: a.owner, phase: a.phase, reviewDigest: a.reviewDigest, proofDigest: a.proofDigest, issuedAt: a.issuedAt, expiresAt: a.expiresAt };
    const { digest: proofHash, ...proofBase } = proof;
    if (a.owner !== owner || a.id !== id || review.owner !== owner || proof.owner !== owner || review.digest !== a.reviewDigest
      || proofHash !== a.proofDigest || fundingDigest(proofBase) !== proofHash || proof.reviewDigest !== a.reviewDigest
      || snapshot(base, review, proof) !== a.snapshotDigest || a.expiresAt !== proof.expiresAt || a.issuedAt !== proof.readAt
      || (['hash-recorded', 'confirmed', 'reverted'].includes(a.status) && !a.transactionHash)
      || (['owner-rejected', 'owner-cancelled-unsent'].includes(a.status) && a.transactionHash)
      || (a.status === 'owner-cancelled-unsent' && !a.unsentAttestationProof)) return fail();
    const resolution = a.resolution as GnosisFundingResolution | null;
    if ((a.status === 'confirmed' || a.status === 'reverted') && (!resolution || resolution.outcome !== a.status
      || resolution.transactionHash !== a.transactionHash || resolution.destinationArrival !== 'not-certified')) return fail();
    return { ...a, resolution };
  } catch { return fail(); }
}
async function loadAttempt(tx: SqlExecutor, owner: Address, id: string): Promise<Attempt> {
  const rows = await tx.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [attemptKey(owner, id)]);
  if (rows.rowCount !== 1) return fail(); return parsedAttempt(rows.rows[0].value, owner, id);
}
async function loadState(tx: SqlExecutor, owner: Address, lock = false): Promise<State | null> {
  const rows = await tx.query<{ value: unknown }>(`SELECT value FROM app_settings WHERE key=$1${lock ? ' FOR UPDATE' : ''}`, [stateKey(owner)]);
  if (!rows.rowCount) return null; const p = stateSchema.safeParse(rows.rows[0].value);
  if (!p.success || p.data.owner !== owner) return fail(); return p.data;
}
async function save(tx: SqlExecutor, key: string, value: unknown) {
  await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()', [key, JSON.stringify(value)]);
}
const view = (a: Attempt): GnosisFundingAttemptView => ({ id: a.id, owner: a.owner, phase: a.phase, status: a.status,
  reviewDigest: a.reviewDigest, proofDigest: a.proofDigest, snapshotDigest: a.snapshotDigest, issuedAt: a.issuedAt, expiresAt: a.expiresAt,
  transactionHash: a.transactionHash, resolution: a.resolution, ...(a.unsentAttestationProof ? { unsentAttestationProof: a.unsentAttestationProof } : {}) });
async function fence(tx: SqlExecutor, owner: Address, state: State | null): Promise<GnosisFundingFence> {
  if (!state) return { blocked: false, active: null, fundCompleted: false, lastApproval: null };
  const active = state.activeId ? await loadAttempt(tx, owner, state.activeId) : null;
  if (active && !['reserved', 'hash-recorded', 'unknown'].includes(active.status)) return fail();
  const completed = state.completedFundId ? await loadAttempt(tx, owner, state.completedFundId) : null;
  if (completed && (completed.status !== 'confirmed' || completed.phase !== 'fund')) return fail();
  const lastApproval = state.lastApprovalId ? await loadAttempt(tx, owner, state.lastApprovalId) : null;
  if (lastApproval && (lastApproval.status !== 'confirmed' || lastApproval.phase !== 'approve')) return fail();
  return { blocked: !!active || !!completed, active: active ? view(active) : null, fundCompleted: !!completed, lastApproval: lastApproval ? view(lastApproval) : null };
}
export async function readGnosisFundingFence(ownerInput: string, deps: Dependencies = {}): Promise<GnosisFundingFence> {
  const owner = address(ownerInput), tx = { query: deps.read ?? query }; return fence(tx, owner, await loadState(tx, owner));
}
export async function saveGnosisFundingArtifact(prepared: GnosisFundingPrepared, deps: Dependencies = {}) {
  const { audit, rawQuote } = prepared;
  if (!rawQuote || audit.status !== 'reviewable' || !audit.review || !audit.freshProof) return;
  const value = artifactSchema.parse({ version: 1, owner: audit.owner, observedAt: audit.review.observedAt, reviewDigest: audit.review.digest,
    proofDigest: audit.freshProof.digest, rawQuoteJson: JSON.stringify(rawQuote), reviewJson: JSON.stringify(audit.review), proofJson: JSON.stringify(audit.freshProof) });
  await save({ query: deps.read ?? query }, artifactKey(audit.owner), value);
}
export async function reserveGnosisFundingAttempt(input: { owner: string; phase: GnosisFundingPhase; reviewDigest: Hex; proofDigest: Hex }, deps: Dependencies = {}): Promise<GnosisFundingReservation> {
  const owner = address(input.owner), read = deps.read ?? query, transact = deps.transact ?? transaction;
  if (!['approve', 'fund'].includes(input.phase) || !digest.safeParse(input.reviewDigest).success || !digest.safeParse(input.proofDigest).success) return fail('wallet_gnosis_funding_request_invalid');
  const rows = await read<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [artifactKey(owner)]), stored = artifactSchema.safeParse(rows.rows[0]?.value);
  if (!stored.success || stored.data.owner !== owner || stored.data.reviewDigest !== input.reviewDigest || stored.data.proofDigest !== input.proofDigest) return fail('wallet_gnosis_funding_review_changed');
  const { review, freshProof } = await (deps.verify ?? verifyGnosisFundingReview)(decodeJson(stored.data.rawQuoteJson), owner, stored.data.observedAt);
  if (review.digest !== input.reviewDigest || freshProof.reviewDigest !== input.reviewDigest) return fail('wallet_gnosis_funding_review_changed');
  const now = (deps.clock ?? (() => Math.floor(Date.now() / 1000)))();
  if (freshProof.expiresAt <= now || now < freshProof.readAt || now - freshProof.readAt > 15) return fail('wallet_gnosis_funding_stale');
  if (input.phase === 'fund' && freshProof.sourceAllowanceRaw !== review.approval.amountRaw) return fail('wallet_gnosis_funding_finite_approval_required');
  if (input.phase === 'approve' && freshProof.sourceAllowanceRaw === review.approval.amountRaw) return fail('wallet_gnosis_funding_approval_not_required');
  return transact(async tx => {
    const initial: State = { version: 1, owner, activeId: null, lastApprovalId: null, completedFundId: null };
    await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO NOTHING', [stateKey(owner), JSON.stringify(initial)]);
    const state = (await loadState(tx, owner, true))!, currentFence = await fence(tx, owner, state);
    if (currentFence.blocked) return fail('wallet_gnosis_funding_attempt_pending');
    // The immutable cache's revision fence shares this transaction. A source
    // quarantine committed during the RPC awaits cannot authorize a prompt.
    const cache = await tx.query<{key:string; value: unknown }>('SELECT key,value FROM app_settings WHERE key=ANY($1::text[]) ORDER BY key FOR SHARE',
      [[GNOSIS_EMA_CACHE_PREFIX+'quarantine',GNOSIS_LEGACY_CACHE_PREFIX+'quarantine']]);
    const schema=z.object({version:z.literal(1),quarantined:z.literal(false)}).strict();
    if (!cache.rows.some(r=>r.key===GNOSIS_EMA_CACHE_PREFIX+'quarantine')||cache.rows.some(r=>!schema.safeParse(r.value).success)
      || freshProof.history.identity !== GNOSIS_HISTORY_IDENTITY) return fail('wallet_gnosis_funding_history_required');
    const current = await tx.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [artifactKey(owner)]);
    const artifact = artifactSchema.safeParse(current.rows[0]?.value);
    if (!artifact.success || artifact.data.reviewDigest !== input.reviewDigest || artifact.data.proofDigest !== input.proofDigest) return fail('wallet_gnosis_funding_review_changed');
    const at = (deps.clock ?? (() => Math.floor(Date.now() / 1000)))();
    if (at >= freshProof.expiresAt) return fail('wallet_gnosis_funding_stale');
    const base = { id: randomUUID(), owner, phase: input.phase, reviewDigest: review.digest, proofDigest: freshProof.digest,
      issuedAt: freshProof.readAt, expiresAt: freshProof.expiresAt };
    const a: Attempt = { ...base, snapshotDigest: snapshot(base, review, freshProof), status: 'reserved', transactionHash: null, resolution: null,
      reviewJson: JSON.stringify(review), proofJson: JSON.stringify(freshProof) };
    await save(tx, attemptKey(owner, a.id), a); await save(tx, stateKey(owner), { ...state, activeId: a.id });
    await tx.query('INSERT INTO audit_events(event,detail) VALUES($1,$2::jsonb)', ['wallet.gnosis.funding.reserved', JSON.stringify({ id: a.id, owner, phase: a.phase, at })]);
    return { version: 1, attempt: view(a), review, freshProof, transaction: a.phase === 'approve'
      ? { chainId: 1, from: owner, to: review.approval.token, value: '0x0', data: review.approval.data } : review.transaction };
  });
}
async function update(ownerInput: string, id: string, action: (a: Attempt, state: State) => Promise<{ attempt: Attempt; state: State }>, deps: Dependencies) {
  const owner = address(ownerInput); if (!z.string().uuid().safeParse(id).success) return fail('wallet_gnosis_funding_request_invalid');
  return (deps.transact ?? transaction)(async tx => {
    const state = await loadState(tx, owner, true); if (!state) return fail(); const a = await loadAttempt(tx, owner, id);
    const next = await action(a, state); await save(tx, attemptKey(owner, id), next.attempt); await save(tx, stateKey(owner), next.state);
    if (next.attempt.status !== a.status) await tx.query('INSERT INTO audit_events(event,detail) VALUES($1,$2::jsonb)',
      ['wallet.gnosis.funding.attempt_state', JSON.stringify({ id, owner, phase: a.phase, before: a.status, after: next.attempt.status })]);
    return { attempt: view(next.attempt), fence: await fence(tx, owner, next.state) };
  });
}
export async function recordGnosisFundingHash(owner: string, id: string, hash: Hex, deps: Dependencies = {}) {
  if (!digest.safeParse(hash).success) return fail('wallet_gnosis_funding_request_invalid');
  return update(owner, id, async (a, s) => {
    if (a.transactionHash === hash) return { attempt: a, state: s };
    if (a.transactionHash || s.activeId !== id || !['reserved', 'unknown'].includes(a.status)) return fail('wallet_gnosis_funding_attempt_changed');
    return { attempt: { ...a, transactionHash: hash, status: 'hash-recorded' }, state: s };
  }, deps);
}
export async function markGnosisFundingUnknown(owner: string, id: string, deps: Dependencies = {}) {
  return update(owner, id, async (a, s) => {
    if (s.activeId !== id || !['reserved', 'hash-recorded', 'unknown'].includes(a.status)) return fail('wallet_gnosis_funding_attempt_changed');
    return { attempt: { ...a, status: 'unknown' }, state: s };
  }, deps);
}
export async function attestGnosisFundingRejection(owner: string, id: string, code: number, deps: Dependencies = {}) {
  if (code !== 4001) return fail('wallet_gnosis_funding_request_invalid');
  return update(owner, id, async (a, s) => {
    if (a.status === 'owner-rejected') return { attempt: a, state: s };
    if (a.transactionHash || s.activeId !== id || !['reserved', 'unknown'].includes(a.status)) return fail('wallet_gnosis_funding_attempt_changed');
    return { attempt: { ...a, status: 'owner-rejected' }, state: { ...s, activeId: null } };
  }, deps);
}
export async function cancelGnosisFundingUnsent(ownerInput: string, id: string, snapshotDigest: Hex, requestIssued: false, deps: Dependencies = {}) {
  const owner = address(ownerInput);
  if (requestIssued !== false || !digest.safeParse(snapshotDigest).success) return fail('wallet_gnosis_funding_request_invalid');
  const a = await loadAttempt({ query: deps.read ?? query }, owner, id);
  if (a.status !== 'reserved' || a.transactionHash || a.snapshotDigest !== snapshotDigest) return fail('wallet_gnosis_funding_attempt_changed');
  const proof = await (deps.proveUnsent ?? proveGnosisFundingNoSourceEffect)({ phase: a.phase, owner,
    review: decodeJson(a.reviewJson), freshProof: decodeJson(a.proofJson) });
  return update(owner, id, async (current, state) => {
    if (state.activeId !== id || current.status !== 'reserved' || current.transactionHash || current.snapshotDigest !== snapshotDigest) return fail('wallet_gnosis_funding_attempt_changed');
    return { attempt: { ...current, status: 'owner-cancelled-unsent', unsentAttestationProof: proof }, state: { ...state, activeId: null } };
  }, deps);
}
export async function resolveGnosisFundingAttempt(ownerInput: string, id: string, deps: Dependencies = {}) {
  const owner = address(ownerInput), a = await loadAttempt({ query: deps.read ?? query }, owner, id);
  if (!a.transactionHash || a.status === 'confirmed' || a.status === 'reverted') return { attempt: view(a), fence: await readGnosisFundingFence(owner, deps) };
  const resolution = await (deps.resolve ?? resolveGnosisFundingReceipt)({ phase: a.phase, owner, transactionHash: a.transactionHash,
    review: decodeJson(a.reviewJson), freshProof: decodeJson(a.proofJson) });
  if (!resolution) return { attempt: view(a), fence: await readGnosisFundingFence(owner, deps) };
  return update(owner, id, async (current, s) => {
    if (current.transactionHash !== a.transactionHash || s.activeId !== id || !['hash-recorded', 'unknown'].includes(current.status)
      || resolution.transactionHash !== a.transactionHash) return fail('wallet_gnosis_funding_attempt_changed');
    return { attempt: { ...current, status: resolution.outcome, resolution }, state: { ...s, activeId: null,
      ...(resolution.outcome === 'confirmed' ? current.phase === 'fund' ? { completedFundId: id } : { lastApprovalId: id } : {}) } };
  }, deps);
}

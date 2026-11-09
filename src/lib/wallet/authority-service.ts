import 'server-only';
import { randomUUID } from 'node:crypto';
import { recoverTypedDataAddress, type Hex } from 'viem';
import type { SqlExecutor } from '../db';
import { loadStrategyProfile, type LoadedStrategyProfile } from './strategy-profile';
import { AuthorityError, authorityBlockCurrent, authorityNow, authoritySignatureValid, closeVerificationReady, createAuthorityCloseReview, createAuthorityReview,
  verificationReady, type AuthorityPreparation, type AuthorityReview, type AuthorityVerification,
  type AuthorityCloseInputs, type AuthorityCloseReview, type AuthorityCloseVerification } from './authority';
import { loadAuthority, saveAuthority, sealAuthoritySignature, type AuthorityRecord } from './authority-store';

/** Root-owned production adapter. All methods read canonical chain evidence.
 * prepareClose additionally acquires the real account lease and durably fences
 * entries before enumerating the complete tracked standing UID set. */
export interface AuthorityEnvironment {
  prepare(profile: LoadedStrategyProfile, now: number): Promise<AuthorityPreparation>;
  verify(review: AuthorityReview, now: number, evidence?: { transactionHashes: Hex[]; mode?: 'initial' | 'runtime' }): Promise<AuthorityVerification>;
  prepareClose(review: AuthorityReview, now: number): Promise<AuthorityCloseInputs>;
  verifyClose(review: AuthorityReview, close: AuthorityCloseReview, now: number, evidence?: { transactionHashes: Hex[] }): Promise<AuthorityCloseVerification>;
}
export type AuthorityPublic = {
  version: 1; state: AuthorityRecord['state'] | 'missing' | 'unconfigured'; revision: number | null;
  review: AuthorityReview | null; close: AuthorityCloseReview | null; verifiedAt: number | null; readAt: number;
  lifetime: 'not-started' | 'within-window' | 'expired' | 'unknown'; blockers: string[];
  executionReadiness: 'not-certified'; ownerTransactionHashes: Hex[]; candidateTransactionHashes: Hex[]; candidateCallBatchIds: string[];
};
export function publicAuthority(record: AuthorityRecord | null, now: number, environmentPresent = true): AuthorityPublic {
  authorityNow(now);
  return { version: 1, state: record?.state ?? (environmentPresent ? 'missing' : 'unconfigured'), revision: record?.revision ?? null,
    review: record?.review ?? null, close: record?.close ?? null, verifiedAt: record?.verifiedAt ?? null, readAt: now,
    lifetime: !record ? 'unknown' : now < record.review.terms.startsAt ? 'not-started' : now >= record.review.terms.expiresAt ? 'expired' : 'within-window',
    blockers: environmentPresent ? [] : ['wallet_authority_environment_missing'], executionReadiness: 'not-certified',
    ownerTransactionHashes: record?.ownerTransactionHashes ?? [], candidateTransactionHashes: record?.candidateTransactionHashes ?? [],
    candidateCallBatchIds: record?.candidateCallBatchIds ?? [] };
}
function environment(env: AuthorityEnvironment | null): AuthorityEnvironment {
  if (!env) throw new AuthorityError('wallet_authority_environment_missing');
  return env;
}
async function profileFor(tx: SqlExecutor, review?: AuthorityReview, now = Math.floor(Date.now() / 1000)) {
  const p = await loadStrategyProfile(tx, now);
  if (!p || p.profile.chainId !== 1 || p.profile.implementation.kind !== 'cow-candidate' || p.profile.markets.length > 30) {
    throw new AuthorityError('wallet_authority_profile_missing_or_unsupported');
  }
  if (review && (p.revision !== review.profileRevision || p.profile.owner !== review.owner.toLowerCase()
    || p.profile.executor !== review.executor.toLowerCase())) throw new AuthorityError('wallet_authority_profile_changed');
  return p;
}
function assertProfileScope(p: LoadedStrategyProfile, review: AuthorityReview) {
  const profile = p.profile, terms = review.terms;
  const wanted = new Set(profile.markets.map(m => m.baseToken));
  const signed = new Set(terms.markets.map(m => m.baseToken.toLowerCase()));
  const contracts = Object.values({ manager: review.contracts.manager, enforcer: review.contracts.enforcer, settlement: review.contracts.settlement,
    vaultRelayer: review.contracts.vaultRelayer }).map(v => v.toLowerCase());
  if (terms.owner.toLowerCase() !== profile.owner || terms.executor.toLowerCase() !== profile.executor
    || terms.quoteToken.toLowerCase() !== profile.quoteToken || signed.size !== wanted.size || [...wanted].some(t => !signed.has(t))
    || terms.startsAt !== profile.authority.startsAt || terms.expiresAt !== profile.authority.expiresAt
    || contracts.some(a => !profile.authority.scope.contracts.includes(a))) throw new AuthorityError('wallet_authority_scope_mismatch');
}
async function current(tx: SqlExecutor, id: string, digest: Hex, revision: number, now: number, allowExpiredReview = false) {
  const record = await loadAuthority(tx);
  if (!record || record.review.id !== id || record.review.digest !== digest || record.revision !== revision) throw new AuthorityError('wallet_authority_revision_conflict');
  if (!allowExpiredReview && now >= record.review.reviewExpiresAt) throw new AuthorityError('wallet_authority_review_expired');
  return record;
}
export async function prepareAuthority(tx: SqlExecutor, env: AuthorityEnvironment | null, expectedRevision: number | null, now: number) {
  authorityNow(now); const e = environment(env), existing = await loadAuthority(tx);
  if ((existing?.revision ?? null) !== expectedRevision) throw new AuthorityError('wallet_authority_revision_conflict');
  // Replacing an active or closing bearer grant would lose its cleanup ledger.
  if (existing && ['verified', 'closing'].includes(existing.state)) throw new AuthorityError('wallet_authority_close_required');
  const profile = await profileFor(tx, undefined, now), prepared = await e.prepare(profile, now);
  // Display amounts come from the same server-verified token mapping as the
  // policy. The browser never supplies decimals, ticker labels or unit scales.
  const preparation = { ...prepared, allowances: prepared.allowances.map(a => {
    if (a.token.toLowerCase() === profile.profile.quoteToken) return { ...a, decimals: profile.profile.quoteDecimals, label: profile.profile.conversion.quoteUnit };
    const market = profile.profile.markets.find(m => m.baseToken === a.token.toLowerCase());
    return market ? { ...a, decimals: market.baseDecimals, label: market.symbol.replace(/-EUR$/, '') } : a;
  }) };
  const review = createAuthorityReview({ id: randomUUID(), profileRevision: profile.revision, preparation, now });
  assertProfileScope(profile, review);
  const saved = await saveAuthority(tx, { state: review.blockers.length ? 'blocked' : 'draft', review, signatureCiphertext: null,
    close: null, verifiedAt: null, updatedAt: now, ownerTransactionHashes: existing?.state === 'closed' ? [] : existing?.ownerTransactionHashes ?? [],
    candidateTransactionHashes: existing?.state === 'closed' ? [] : existing?.candidateTransactionHashes ?? [],
    candidateCallBatchIds: existing?.state === 'closed' ? [] : existing?.candidateCallBatchIds ?? [] }, expectedRevision);
  if (existing) await tx.query('INSERT INTO audit_events(event,detail) VALUES($1,$2::jsonb)', ['wallet.authority.review.superseded', JSON.stringify({
    previousReviewId: existing.review.id, previousDigest: existing.review.digest, profileRevision: existing.review.profileRevision, review: existing.review,
    nextReviewId: review.id, ownerTransactionHashes: existing.ownerTransactionHashes ?? [], candidateTransactionHashes: existing.candidateTransactionHashes ?? [],
    candidateCallBatchIds: existing.candidateCallBatchIds ?? [], at: now,
  })]);
  return saved;
}
function transactionHashList(hashes: Hex[]) {
  if (!Array.isArray(hashes) || hashes.length > 64 || hashes.some(h => typeof h !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(h))) throw new AuthorityError('wallet_authority_receipt_invalid');
  return [...new Set(hashes.map(h => h.toLowerCase() as Hex))];
}
/** Submitted hashes are durable candidates only. No receipt, fee, successful
 * transaction or authority readiness is inferred from the browser submission. */
export async function recordAuthorityOwnerActions(tx: SqlExecutor,
  input: { id: string; digest: Hex; expectedRevision: number; transactionHashes?: Hex[]; callBatchIds?: string[]; closeDigest?: Hex }, now: number) {
  authorityNow(now); const record = await current(tx, input.id, input.digest, input.expectedRevision, now, true);
  const closing = record.state === 'closing';
  if (['verified', 'closed'].includes(record.state) || (closing && (!record.close || record.close.digest !== input.closeDigest))
    || (!closing && input.closeDigest)) throw new AuthorityError('wallet_authority_state_invalid');
  const hashes = transactionHashList([...(record.candidateTransactionHashes ?? []), ...(input.transactionHashes ?? [])]);
  const callBatchIds = [...new Set([...(record.candidateCallBatchIds ?? []), ...(input.callBatchIds ?? [])])];
  if (callBatchIds.length > 8 || callBatchIds.some(id => !/^0x[0-9a-fA-F]{1,256}$/.test(id))
    || (!hashes.length && !callBatchIds.length)) throw new AuthorityError('wallet_authority_receipt_invalid');
  return saveAuthority(tx, { ...record, state: closing ? 'closing' : 'owner-actions-pending', candidateTransactionHashes: hashes,
    candidateCallBatchIds: callBatchIds, updatedAt: now }, record.revision);
}
export async function verifyAuthorityOwnerActions(tx: SqlExecutor, env: AuthorityEnvironment | null,
  input: { id: string; digest: Hex; expectedRevision: number; transactionHashes?: Hex[] }, now: number) {
  const e = environment(env), record = await current(tx, input.id, input.digest, input.expectedRevision, now, true);
  if (['closing', 'closed', 'verified'].includes(record.state)) throw new AuthorityError('wallet_authority_state_invalid');
  await profileFor(tx, record.review, now);
  const transactionHashes = transactionHashList(input.transactionHashes ?? [...(record.ownerTransactionHashes ?? []), ...(record.candidateTransactionHashes ?? [])]);
  if ((record.candidateTransactionHashes ?? []).some(h => !transactionHashes.includes(h))
    || ((record.candidateCallBatchIds?.length ?? 0) > 0 && !transactionHashes.length)) throw new AuthorityError('wallet_authority_receipt_missing');
  const verified = await e.verify(record.review, now, { transactionHashes, mode: 'initial' });
  if (!verificationReady(verified, now)) throw new AuthorityError('wallet_authority_owner_actions_unverified');
  return saveAuthority(tx, { ...record, state: 'signature-pending', updatedAt: now, ownerTransactionHashes: transactionHashes,
    candidateTransactionHashes: [], candidateCallBatchIds: [] }, record.revision);
}
export async function acceptAuthoritySignature(tx: SqlExecutor, env: AuthorityEnvironment | null,
  input: { id: string; digest: Hex; expectedRevision: number; signature: Hex }, now: number) {
  const e = environment(env), record = await current(tx, input.id, input.digest, input.expectedRevision, now);
  if (record.state !== 'signature-pending') throw new AuthorityError('wallet_authority_state_invalid');
  if (!authoritySignatureValid(input.signature)) throw new AuthorityError('wallet_authority_signature_invalid');
  await profileFor(tx, record.review, now);
  if (now < record.review.terms.startsAt || now >= record.review.terms.expiresAt) throw new AuthorityError('wallet_authority_lifetime_invalid');
  let signer: string;
  try { signer = await recoverTypedDataAddress({ ...record.review.delegation.typed, signature: input.signature }); }
  catch { throw new AuthorityError('wallet_authority_signature_invalid'); }
  if (signer.toLowerCase() !== record.review.owner.toLowerCase()) throw new AuthorityError('wallet_authority_signature_invalid');
  if (!verificationReady(await e.verify(record.review, now, { transactionHashes: record.ownerTransactionHashes ?? [], mode: 'initial' }), now)) throw new AuthorityError('wallet_authority_owner_actions_unverified');
  return saveAuthority(tx, { ...record, state: 'verified', signatureCiphertext: sealAuthoritySignature(record.review, input.signature),
    verifiedAt: now, updatedAt: now }, record.revision);
}
export async function recheckAuthority(tx: SqlExecutor, env: AuthorityEnvironment | null, now: number) {
  authorityNow(now); const e = environment(env), record = await loadAuthority(tx);
  if (!record || record.state !== 'verified') return record;
  let profileCurrent = true;
  try { await profileFor(tx, record.review, now); }
  catch (error) {
    if (error instanceof AuthorityError && ['wallet_authority_profile_changed', 'wallet_authority_profile_missing_or_unsupported'].includes(error.code)) profileCurrent = false;
    else throw error;
  }
  // An unavailable RPC is not revocation. The adapter throws a sanitized
  // availability error; keep the encrypted grant for a later canonical check.
  if (profileCurrent && now < record.review.terms.expiresAt) {
    const verified = await e.verify(record.review, now, { transactionHashes: record.ownerTransactionHashes ?? [], mode: 'runtime' });
    const definitive = ['managerCode', 'implementationCode', 'enforcerCode', 'settlementCode', 'vaultRelayerCode',
      'tokenCodes', 'ownerImplementation', 'delegationEnabled', 'profileCurrent'] as const;
    if (!authorityBlockCurrent(verified.block, now) || definitive.some(k => typeof verified[k] !== 'boolean')) {
      throw new AuthorityError('wallet_authority_verification_unavailable');
    }
    if (definitive.every(k => verified[k])) {
      // Spent allowance, gas availability or a read dependency can recover.
      // They fail execution's fresh readiness check without destroying a grant.
      if (!verificationReady(verified, now) || now < record.review.terms.startsAt) throw new AuthorityError('wallet_authority_verification_unavailable');
      return record;
    }
  }
  // Preserve grant and UID cleanup ability; a blocked grant cannot be replaced.
  return saveAuthority(tx, { ...record, state: 'closing', close: null, updatedAt: now }, record.revision);
}
export async function prepareAuthorityClose(tx: SqlExecutor, env: AuthorityEnvironment | null,
  input: { id: string; digest: Hex; expectedRevision: number }, now: number) {
  authorityNow(now); const e = environment(env), record = await current(tx, input.id, input.digest, input.expectedRevision, now, true);
  if (record.state === 'closed') throw new AuthorityError('wallet_authority_state_invalid');
  // Persist a runtime-readable fence before any asynchronous network work.
  if (record.close) await tx.query('INSERT INTO audit_events(event,detail) VALUES($1,$2::jsonb)', ['wallet.authority.close.review.superseded', JSON.stringify({
    authorityDigest: record.review.digest, close: record.close, candidateTransactionHashes: record.candidateTransactionHashes ?? [],
    candidateCallBatchIds: record.candidateCallBatchIds ?? [], at: now,
  })]);
  const fenced = await saveAuthority(tx, { ...record, state: 'closing', close: null, updatedAt: now }, record.revision);
  const close = createAuthorityCloseReview(fenced.review, await e.prepareClose(fenced.review, now), now);
  return saveAuthority(tx, { ...fenced, close, updatedAt: now }, fenced.revision);
}
export async function verifyAuthorityClose(tx: SqlExecutor, env: AuthorityEnvironment | null,
  input: { id: string; digest: Hex; expectedRevision: number; closeDigest: Hex; transactionHashes?: Hex[] }, now: number) {
  authorityNow(now); const e = environment(env), record = await current(tx, input.id, input.digest, input.expectedRevision, now, true);
  if (record.state !== 'closing' || !record.close || record.close.digest !== input.closeDigest) {
    throw new AuthorityError('wallet_authority_close_invalid');
  }
  const transactionHashes = transactionHashList(input.transactionHashes ?? record.candidateTransactionHashes ?? []);
  if ((record.candidateTransactionHashes ?? []).some(h => !transactionHashes.includes(h))
    || ((record.candidateCallBatchIds?.length ?? 0) > 0 && !transactionHashes.length)) throw new AuthorityError('wallet_authority_receipt_missing');
  const verification = await e.verifyClose(record.review, record.close, now, { transactionHashes });
  if (!closeVerificationReady(verification, now)) {
    if (verification.receiptsVerified === true && transactionHashes.length) return saveAuthority(tx, { ...record,
      candidateTransactionHashes: [], candidateCallBatchIds: [], updatedAt: now }, record.revision);
    throw new AuthorityError('wallet_authority_close_unverified');
  }
  return saveAuthority(tx, { ...record, state: 'closed', signatureCiphertext: null, candidateTransactionHashes: [], candidateCallBatchIds: [], updatedAt: now }, record.revision);
}

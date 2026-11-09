import 'server-only';
import { z } from 'zod';
import type { SqlExecutor } from '../db';
import { decryptSecret, encryptSecret } from '../secrets';
import { AuthorityError, authorityDigest, authoritySignatureValid, createAuthorityCloseReview, parseAuthorityReview, type AuthorityCloseReview, type AuthorityReview } from './authority';

export const AUTHORITY_KEY = 'wallet:strategy:authority:v1';
export type AuthorityState = 'draft' | 'owner-actions-pending' | 'signature-pending' | 'verified' | 'closing' | 'closed' | 'blocked';
export interface AuthorityRecord {
  storageVersion: 1; revision: number; state: AuthorityState; review: AuthorityReview;
  signatureCiphertext: string | null; verifiedAt: number | null; updatedAt: number;
  close: AuthorityCloseReview | null; ownerTransactionHashes?: `0x${string}`[]; candidateTransactionHashes?: `0x${string}`[];
  candidateCallBatchIds?: string[];
}
const storedSchema = z.object({ storageVersion: z.literal(1), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(['draft', 'owner-actions-pending', 'signature-pending', 'verified', 'closing', 'closed', 'blocked']),
  review: z.unknown(), signatureCiphertext: z.string().max(2000).nullable(), verifiedAt: z.number().int().nonnegative().nullable(),
  updatedAt: z.number().int().nonnegative(), close: z.unknown().nullable(),
  ownerTransactionHashes: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v => v.toLowerCase() as `0x${string}`)).max(64).default([]),
  candidateTransactionHashes: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v => v.toLowerCase() as `0x${string}`)).max(64).default([]),
  candidateCallBatchIds: z.array(z.string().regex(/^0x[0-9a-fA-F]{1,256}$/)).max(8).default([]) }).strict();
const context = (r: AuthorityReview) => `wallet-authority:v1:${r.chainId}:${r.owner.toLowerCase()}:${r.profileRevision}:${r.digest}`;
export function sealAuthoritySignature(review: AuthorityReview, signature: string): string {
  if (!authoritySignatureValid(signature)) throw new AuthorityError('wallet_authority_signature_invalid');
  return encryptSecret(signature, context(review));
}
export function openAuthoritySignature(record: AuthorityRecord): `0x${string}` {
  if (!record.signatureCiphertext) throw new AuthorityError('wallet_authority_signature_missing');
  let signature: string;
  try { signature = decryptSecret(record.signatureCiphertext, context(record.review)); }
  catch { throw new AuthorityError('wallet_authority_signature_invalid'); }
  if (!authoritySignatureValid(signature)) throw new AuthorityError('wallet_authority_signature_invalid');
  return signature as `0x${string}`;
}
function parseRecord(raw: unknown): AuthorityRecord {
  try {
    const parsed = storedSchema.parse(raw), review = parseAuthorityReview(parsed.review);
    const close = parsed.close as AuthorityCloseReview | null;
    if (close) {
      const rebuilt = createAuthorityCloseReview(review, { block: close.block, outstandingUids: close.outstandingUids,
        fenceReference: close.fenceReference, blockers: close.blockers, remainingOrders: close.remainingOrders, totalTrackedOrders: close.totalTrackedOrders }, close.createdAt);
      if (authorityDigest(close) !== authorityDigest(rebuilt)) throw new Error();
    }
    if (parsed.state === 'verified' && (!parsed.signatureCiphertext || parsed.verifiedAt === null)) throw new Error();
    return { ...parsed, review, close };
  } catch { throw new AuthorityError('wallet_authority_stored_invalid'); }
}
export async function loadAuthority(tx: SqlExecutor): Promise<AuthorityRecord | null> {
  const result = await tx.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [AUTHORITY_KEY]);
  return result.rowCount ? parseRecord(result.rows[0].value) : null;
}
export async function saveAuthority(tx: SqlExecutor, value: Omit<AuthorityRecord, 'storageVersion' | 'revision'>,
  expectedRevision: number | null): Promise<AuthorityRecord> {
  if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision >= Number.MAX_SAFE_INTEGER)) {
    throw new AuthorityError('wallet_authority_revision_invalid');
  }
  const record = parseRecord({ ...value, storageVersion: 1, revision: expectedRevision === null ? 1 : expectedRevision + 1 });
  const result = expectedRevision === null
    ? await tx.query<{ value: unknown }>('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO NOTHING RETURNING value', [AUTHORITY_KEY, JSON.stringify(record)])
    : await tx.query<{ value: unknown }>(`UPDATE app_settings SET value=$2::jsonb,updated_at=NOW()
      WHERE key=$1 AND value->>'storageVersion'='1' AND value->>'revision'=$3 RETURNING value`, [AUTHORITY_KEY, JSON.stringify(record), String(expectedRevision)]);
  if (result.rowCount !== 1) throw new AuthorityError('wallet_authority_revision_conflict');
  return parseRecord(result.rows[0].value);
}
/** Server runtime only. This is stored evidence, never current chain readiness:
 * the source must recheck chain, lifetime, revocation and profile before writes. */
export async function loadVerifiedAuthorityForRuntime(tx: SqlExecutor, now = Math.floor(Date.now() / 1000)) {
  const record = await loadAuthority(tx);
  if (!record || record.state !== 'verified' || !Number.isSafeInteger(now)
    || now < record.review.terms.startsAt || now >= record.review.terms.expiresAt) return null;
  return { revision: record.revision, review: record.review, signature: openAuthoritySignature(record), verifiedAt: record.verifiedAt,
    ownerTransactionHashes: record.ownerTransactionHashes ?? [] };
}

import { z } from 'zod';
import { requireMutation, requireSession, refreshSessionCookie } from '@/lib/auth';
import { query } from '@/lib/db';
import { body, failure, json } from '@/lib/http';
import { AuthorityError } from '@/lib/wallet/authority';
import { loadAuthority } from '@/lib/wallet/authority-store';
import { productionAuthorityEnvironment } from '@/lib/wallet/authority-environment';
import { assertCowSetupFeasible } from '@/lib/wallet/cow-feasibility';
import { loadStrategyProfile } from '@/lib/wallet/strategy-profile';
import { acceptAuthoritySignature, prepareAuthority, prepareAuthorityClose, publicAuthority,
  recordAuthorityOwnerActions, recheckAuthority, verifyAuthorityClose, verifyAuthorityOwnerActions } from '@/lib/wallet/authority-service';
import { cancelAuthorityActionUnsent, markAuthorityActionUnknown, readAuthorityActionFence, recordAuthorityActionReferences,
  rejectAuthorityAction, reserveAuthorityAction, resolveAuthorityAction } from '@/lib/wallet/authority-action-attempts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const digest = z.string().regex(/^0x[0-9a-f]{64}$/);
const identity = { id: z.uuid(), digest, expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1) };
const attemptIdentity = { attemptId: z.uuid(), snapshotDigest: digest };
const hashes = z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)).max(64);
const batches = z.array(z.string().regex(/^0x[0-9a-fA-F]{1,256}$/)).max(1);
const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('reserve-action'), ...identity, phase: z.enum(['deploy', 'bootstrap', 'close']), closeDigest: digest.optional() }).strict(),
  z.object({ action: z.literal('record-action'), ...attemptIdentity, transactionHashes: hashes.optional(), callBatchIds: batches.optional() }).strict(),
  z.object({ action: z.literal('unknown-action'), ...attemptIdentity }).strict(),
  z.object({ action: z.literal('reject-action'), ...attemptIdentity, code: z.literal(4001) }).strict(),
  z.object({ action: z.literal('cancel-unsent-action'), ...attemptIdentity, requestIssued: z.literal(false) }).strict(),
  z.object({ action: z.literal('resolve-action'), ...attemptIdentity, transactionHashes: hashes.optional() }).strict(),
  z.object({ action: z.literal('prepare'), expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1).nullable() }).strict(),
  z.object({ action: z.literal('verify-owner-actions'), ...identity,
    transactionHashes: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)).max(64).optional() }).strict(),
  z.object({ action: z.literal('record-owner-actions'), ...identity,
    transactionHashes: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)).max(64).optional(),
    callBatchIds: z.array(z.string().regex(/^0x[0-9a-fA-F]{1,256}$/)).max(8).optional() }).strict(),
  z.object({ action: z.literal('record-close-actions'), ...identity, closeDigest: digest,
    transactionHashes: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)).max(64).optional(),
    callBatchIds: z.array(z.string().regex(/^0x[0-9a-fA-F]{1,256}$/)).max(8).optional() }).strict(),
  z.object({ action: z.literal('accept-signature'), ...identity, signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).strict(),
  z.object({ action: z.literal('recheck') }).strict(),
  z.object({ action: z.literal('prepare-close'), ...identity }).strict(),
  z.object({ action: z.literal('verify-close'), ...identity, closeDigest: digest,
    transactionHashes: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)).max(64).optional() }).strict(),
]);
function authorityFailure(error: unknown) {
  if (error instanceof AuthorityError) {
    const messages: Record<string, string> = {
      wallet_authority_profile_missing_or_unsupported: 'ابدأ بتجهيز إعداد المحرك من المحفظة والأسواق، ثم أنشئ مراجعة الصلاحية.',
      wallet_authority_runtime_missing: 'جهّز إعداد المحرك من المحفظة والأسواق قبل مراجعة الصلاحية.',
      wallet_authority_feasibility_blocked: 'لم تثبت جدوى التنفيذ ضمن حد التكلفة 0.4%. افحص أصول المحفظة والتكلفة قبل أي تمويل أو توقيع.',
      wallet_authority_review_expired: 'انتهت نافذة المراجعة. أنشئ مراجعة حديثة؛ تبقى مراجع العمليات السابقة محفوظة.',
      wallet_authority_receipt_unfinalized_or_invalid: 'لم تثبت إيصالات العمليات نهائياً. انتظر تأكيد السلسلة وأعد التحقق دون إعادة الإرسال.',
      wallet_authority_verification_unavailable: 'تعذرت قراءة التحقق الحالية. السجل محفوظ؛ أعد التحقق عند عودة القراءة.',
      wallet_authority_source_write_pending: 'توجد عملية إرسال سابقة غير محسومة. الدخول متوقف؛ انتظر تسويتها قبل إعداد الإغلاق ولا تعِد الإرسال.',
      wallet_authority_account_busy: 'المحرك يحسم عملية قائمة الآن. أعد التحقق بعد اكتمالها.',
      wallet_authority_close_unverified: 'لم يثبت إبطال جميع الأوامر وتعطيل التفويض وتصفير الموافقات بعد. أعد التحقق أو جهّز دفعة إغلاق جديدة للمتبقي.',
      wallet_authority_receipt_missing: 'مراجع العمليات محفوظة وتحتاج إيصالاتها. أعد التحقق من حالة العمليات في المحفظة.',
      wallet_authority_owner_actions_unverified: 'لم تثبت هوية العقود والترقية والموافقات المحدودة على السلسلة. راجع المتطلبات وأعد التحقق بعد التأكيد.',
    };
    return json({ code: error.code, error: messages[error.code] ?? 'لم تُثبت هذه الخطوة. حدّث المراجعة وتحقق من الحساب والعقود وحالة السلسلة قبل إعادة المحاولة.' }, 409);
  }
  return failure(error);
}
export async function GET(request: Request) {
  try {
    const session = await requireSession(request), now = Math.floor(Date.now() / 1000);
    const [record, env] = await Promise.all([loadAuthority({ query }), productionAuthorityEnvironment()]);
    const response = json({ ...publicAuthority(record, now, env !== null), actionFence: await readAuthorityActionFence(), csrfToken: session.csrfToken });
    response.headers.append('Set-Cookie', await refreshSessionCookie(request, session));
    return response;
  } catch (error) { return authorityFailure(error); }
}
export async function POST(request: Request) {
  try {
    const session = await requireMutation(request), parsed = inputSchema.safeParse(await body(request));
    if (!parsed.success) throw new AuthorityError('wallet_authority_request_invalid');
    const input = parsed.data, tx = { query };
    let now = Math.floor(Date.now() / 1000);
    // Persist unverified submission references even if RPC setup is unavailable.
    // This metadata path cannot progress a grant or infer a fee/receipt.
    const metadataOnly = input.action === 'record-owner-actions' || input.action === 'record-close-actions'
      || ['record-action', 'unknown-action', 'reject-action', 'cancel-unsent-action', 'resolve-action'].includes(input.action);
    const env = metadataOnly ? null : await productionAuthorityEnvironment();
    if (env && (input.action === 'prepare' || input.action === 'accept-signature')) {
      const profile = await loadStrategyProfile(tx, now);
      if (!profile) throw new AuthorityError('wallet_authority_profile_missing_or_unsupported');
      await assertCowSetupFeasible(profile.profile.owner, profile.profile.chainId);
    }
    // Provider I/O must not freeze a review's validity at request start.
    now = Math.floor(Date.now() / 1000);
    const reference = 'digest' in input ? { id: input.id, digest: input.digest as `0x${string}`, expectedRevision: input.expectedRevision } : null;
    let record, actionReservation, actionAttempt;
    switch (input.action) {
      case 'reserve-action': {
        if (!env) throw new AuthorityError('wallet_authority_environment_missing');
        actionReservation = await reserveAuthorityAction({ ...input, digest: input.digest as `0x${string}`, closeDigest: input.closeDigest as `0x${string}` | undefined });
        record = await loadAuthority(tx); break;
      }
      case 'record-action': actionAttempt = (await recordAuthorityActionReferences({ ...input, snapshotDigest: input.snapshotDigest as `0x${string}`,
        transactionHashes: input.transactionHashes as `0x${string}`[] | undefined })).attempt; record = await loadAuthority(tx); break;
      case 'unknown-action': actionAttempt = (await markAuthorityActionUnknown(input.attemptId, input.snapshotDigest as `0x${string}`)).attempt; record = await loadAuthority(tx); break;
      case 'reject-action': actionAttempt = (await rejectAuthorityAction(input.attemptId, input.snapshotDigest as `0x${string}`, input.code)).attempt; record = await loadAuthority(tx); break;
      case 'cancel-unsent-action': actionAttempt = (await cancelAuthorityActionUnsent(input.attemptId, input.snapshotDigest as `0x${string}`, input.requestIssued)).attempt; record = await loadAuthority(tx); break;
      case 'resolve-action': actionAttempt = (await resolveAuthorityAction(input.attemptId, input.snapshotDigest as `0x${string}`, input.transactionHashes as `0x${string}`[] | undefined)).attempt; record = await loadAuthority(tx); break;
      case 'prepare': record = await prepareAuthority(tx, env, input.expectedRevision, now); break;
      case 'verify-owner-actions': record = await verifyAuthorityOwnerActions(tx, env,
        { ...reference!, transactionHashes: input.transactionHashes as `0x${string}`[] | undefined }, now); break;
      case 'record-owner-actions': record = await recordAuthorityOwnerActions(tx,
        { ...reference!, transactionHashes: input.transactionHashes as `0x${string}`[] | undefined, callBatchIds: input.callBatchIds }, now); break;
      case 'record-close-actions': record = await recordAuthorityOwnerActions(tx,
        { ...reference!, transactionHashes: input.transactionHashes as `0x${string}`[] | undefined, callBatchIds: input.callBatchIds, closeDigest: input.closeDigest as `0x${string}` }, now); break;
      case 'accept-signature': record = await acceptAuthoritySignature(tx, env,
        { ...reference!, signature: input.signature as `0x${string}` }, now); break;
      case 'recheck': record = await recheckAuthority(tx, env, now); break;
      case 'prepare-close': record = await prepareAuthorityClose(tx, env, reference!, now); break;
      case 'verify-close': record = await verifyAuthorityClose(tx, env,
        { ...reference!, closeDigest: input.closeDigest as `0x${string}`, transactionHashes: input.transactionHashes as `0x${string}`[] | undefined }, now); break;
    }
    const response = json({ ...publicAuthority(record, now, metadataOnly || env !== null), actionFence: await readAuthorityActionFence(),
      ...(actionReservation ? { actionReservation } : {}), ...(actionAttempt ? { actionAttempt } : {}), csrfToken: session.csrfToken });
    response.headers.append('Set-Cookie', await refreshSessionCookie(request, session));
    return response;
  } catch (error) { return authorityFailure(error); }
}

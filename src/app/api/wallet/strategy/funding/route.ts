import { z } from 'zod';
import { requireMutation, requireSession, refreshSessionCookie } from '@/lib/auth';
import { body, failure, json } from '@/lib/http';
import { GnosisFundingError, prepareGnosisFundingReview } from '@/lib/wallet/gnosis-funding-service';
import { attestGnosisFundingRejection, cancelGnosisFundingUnsent, markGnosisFundingUnknown, readGnosisFundingFence, recordGnosisFundingHash,
  reserveGnosisFundingAttempt, resolveGnosisFundingAttempt, saveGnosisFundingArtifact } from '@/lib/wallet/gnosis-funding-attempts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const owner = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(v => !/^0x0{40}$/i.test(v));
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v => v.toLowerCase() as `0x${string}`);
const shared = { owner, chainId: z.literal(1) }, attemptId = z.string().uuid();
const inputSchema = z.discriminatedUnion('action', [
  z.object({ ...shared, action: z.literal('quote') }).strict(),
  z.object({ ...shared, action: z.literal('reserve'), phase: z.enum(['approve', 'fund']), reviewDigest: hash, proofDigest: hash }).strict(),
  z.object({ ...shared, action: z.literal('record'), attemptId, transactionHash: hash }).strict(),
  z.object({ ...shared, action: z.literal('resolve'), attemptId }).strict(),
  z.object({ ...shared, action: z.literal('unknown'), attemptId }).strict(),
  z.object({ ...shared, action: z.literal('reject'), attemptId, code: z.literal(4001) }).strict(),
  z.object({ ...shared, action: z.literal('cancel-unsent'), attemptId, snapshotDigest: hash, requestIssued: z.literal(false) }).strict(),
]);
export async function GET(request: Request) {
  try {
    const session = await requireSession(request), url = new URL(request.url);
    if ([...url.searchParams.keys()].some(k => k !== 'owner') || url.searchParams.getAll('owner').length !== 1) throw new GnosisFundingError('wallet_gnosis_funding_request_invalid');
    const parsed = owner.safeParse(url.searchParams.get('owner')); if (!parsed.success) throw new GnosisFundingError('wallet_gnosis_funding_request_invalid');
    const response = json({ fence: await readGnosisFundingFence(parsed.data), csrfToken: session.csrfToken });
    response.headers.append('Set-Cookie', await refreshSessionCookie(request, session)); return response;
  } catch (e) { return failed(e); }
}
export async function POST(request: Request) {
  try {
    const session = await requireMutation(request), parsed = inputSchema.safeParse(await body(request));
    if (!parsed.success) throw new GnosisFundingError('wallet_gnosis_funding_request_invalid');
    const p = parsed.data; let value: unknown;
    if (p.action === 'quote') {
      const prepared = await prepareGnosisFundingReview(p.owner); await saveGnosisFundingArtifact(prepared);
      const fence = await readGnosisFundingFence(p.owner);
      value = { ...prepared.audit, fence, ownerReviewAllowed: prepared.audit.status === 'reviewable' && !fence.blocked,
        blockers: [...prepared.audit.blockers, ...(fence.blocked ? ['wallet_gnosis_funding_attempt_pending'] : [])],
        unverified: prepared.audit.unverified.filter(v => v !== 'prior-owner-prompt-attempt-state') };
    } else if (p.action === 'reserve') value = await reserveGnosisFundingAttempt(p);
    else if (p.action === 'record') value = await recordGnosisFundingHash(p.owner, p.attemptId, p.transactionHash);
    else if (p.action === 'unknown') value = await markGnosisFundingUnknown(p.owner, p.attemptId);
    else if (p.action === 'reject') value = await attestGnosisFundingRejection(p.owner, p.attemptId, p.code);
    else if (p.action === 'cancel-unsent') value = await cancelGnosisFundingUnsent(p.owner, p.attemptId, p.snapshotDigest, p.requestIssued);
    else value = await resolveGnosisFundingAttempt(p.owner, p.attemptId);
    const response = json({ ...(value as object), csrfToken: session.csrfToken });
    response.headers.append('Set-Cookie', await refreshSessionCookie(request, session)); return response;
  } catch (e) { return failed(e); }
}
function failed(error: unknown) {
  if (error instanceof GnosisFundingError) return json({ code: error.code, error: 'تعذر إثبات مراجعة التمويل أو حسم المحاولة السابقة. لم يرسل الخادم أي معاملة.' }, 409);
  return failure(error);
}

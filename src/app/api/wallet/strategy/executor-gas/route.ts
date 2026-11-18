import { z } from 'zod';
import { requireMutation, requireSession, refreshSessionCookie } from '@/lib/auth';
import { body, failure, json } from '@/lib/http';
import { ExecutorGasError, prepareExecutorGasReview } from '@/lib/wallet/gnosis-executor-gas';
import { ExecutorGasReadError } from '@/lib/wallet/gnosis-executor-gas-rpc';
import { cancelExecutorGasUnsent, markExecutorGasUnknown, readExecutorGasFence, recordExecutorGasHash, recordExecutorGasProviderUnauthorized, rejectExecutorGas,
  reserveExecutorGas, resolveExecutorGasAttempt, saveExecutorGasArtifact } from '@/lib/wallet/gnosis-executor-gas-attempts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const owner = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(v => !/^0x0{40}$/i.test(v));
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v => v.toLowerCase() as `0x${string}`), attemptId = z.string().uuid();
const shared = { owner, chainId: z.literal(100) };
const input = z.discriminatedUnion('action', [
  z.object({ ...shared, action: z.literal('review'), expectedExecutor: owner }).strict(),
  z.object({ ...shared, action: z.literal('reserve'), expectedExecutor: owner, reviewDigest: hash, proofDigest: hash }).strict(),
  z.object({ ...shared, action: z.literal('record'), attemptId, transactionHash: hash }).strict(),
  z.object({ ...shared, action: z.literal('unknown'), attemptId }).strict(),
  z.object({ ...shared, action: z.literal('reject'), attemptId, code: z.literal(4001) }).strict(),
  z.object({ ...shared, action: z.literal('provider-unauthorized'), attemptId, snapshotDigest: hash, code: z.literal(4100) }).strict(),
  z.object({ ...shared, action: z.literal('cancel-unsent'), attemptId, snapshotDigest: hash, requestIssued: z.literal(false) }).strict(),
  z.object({ ...shared, action: z.literal('resolve'), attemptId }).strict(),
]);
export async function GET(request: Request) {
  try {
    const session = await requireSession(request), url = new URL(request.url), parsed = owner.safeParse(url.searchParams.get('owner'));
    if (!parsed.success || [...url.searchParams.keys()].some(k => k !== 'owner') || url.searchParams.getAll('owner').length !== 1) throw new ExecutorGasError('wallet_executor_gas_request_invalid');
    const response = json({ fence: await readExecutorGasFence(parsed.data), csrfToken: session.csrfToken });
    response.headers.append('Set-Cookie', await refreshSessionCookie(request, session)); return response;
  } catch (error) { return failed(error); }
}
export async function POST(request: Request) {
  try {
    const session = await requireMutation(request), parsed = input.safeParse(await body(request));
    if (!parsed.success) throw new ExecutorGasError('wallet_executor_gas_request_invalid');
    const p = parsed.data; let result: unknown;
    if (p.action === 'review') {
      const prepared = await prepareExecutorGasReview(p.owner, p.expectedExecutor); await saveExecutorGasArtifact(prepared);
      const fence = await readExecutorGasFence(p.owner);
      result = { ...prepared.audit, fence, ownerReviewAllowed: prepared.audit.status === 'reviewable' && !fence.blocked,
        blockers: [...prepared.audit.blockers, ...(fence.blocked ? ['wallet_executor_gas_attempt_pending'] : [])] };
    } else if (p.action === 'reserve') result = await reserveExecutorGas(p);
    else if (p.action === 'record') result = await recordExecutorGasHash(p.owner, p.attemptId, p.transactionHash);
    else if (p.action === 'unknown') result = await markExecutorGasUnknown(p.owner, p.attemptId);
    else if (p.action === 'reject') result = await rejectExecutorGas(p.owner, p.attemptId, p.code);
    else if (p.action === 'provider-unauthorized') result = await recordExecutorGasProviderUnauthorized(p.owner, p.attemptId, p.snapshotDigest, p.code);
    else if (p.action === 'cancel-unsent') result = await cancelExecutorGasUnsent(p.owner, p.attemptId, p.snapshotDigest, p.requestIssued);
    else result = await resolveExecutorGasAttempt(p.owner, p.attemptId);
    const response = json({ ...(result as object), csrfToken: session.csrfToken });
    response.headers.append('Set-Cookie', await refreshSessionCookie(request, session)); return response;
  } catch (error) { return failed(error); }
}
function failed(error: unknown) {
  if (error instanceof ExecutorGasError || error instanceof ExecutorGasReadError) return json({ code: error.code,
    error: 'تعذر إثبات خطوة غاز المنفّذ أو حسم الطلب السابق. لم يرسل الخادم أي معاملة.' }, 409);
  return failure(error);
}

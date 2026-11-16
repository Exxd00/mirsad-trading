import { z } from 'zod';
import { requireMutation, requireSession, refreshSessionCookie } from '@/lib/auth';
import { body, failure, json } from '@/lib/http';
import { AuthorityError } from '@/lib/wallet/authority';
import { GnosisMarketReadinessJobConflict, readGnosisMarketReadiness, resumeExistingGnosisMarketReadiness, startGnosisMarketReadiness } from '@/lib/wallet/gnosis-market-readiness-job';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    const response = json({ ...await readGnosisMarketReadiness(), csrfToken: session.csrfToken });
    response.headers.append('Set-Cookie', await refreshSessionCookie(request, session)); return response;
  } catch (e) { return failure(e); }
}
export async function POST(request: Request) {
  try {
    const session = await requireMutation(request);
    const input = z.union([z.object({ chainId: z.literal(100) }).strict(), z.object({ chainId: z.literal(100),
      action: z.literal('resume-existing'), expectedJobId: z.uuid() }).strict()]).safeParse(await body(request));
    if (!input.success) throw new AuthorityError('wallet_authority_request_invalid');
    const result = 'action' in input.data ? await resumeExistingGnosisMarketReadiness(input.data.expectedJobId) : await startGnosisMarketReadiness();
    const response = json({ ...result, csrfToken: session.csrfToken });
    response.headers.append('Set-Cookie', await refreshSessionCookie(request, session));
    return response;
  } catch (e) {
    if (e instanceof GnosisMarketReadinessJobConflict) return json({ code: e.code, error: 'تغيّرت مهمة البيانات السابقة. لن تبدأ مهمة جديدة تلقائيًا.' }, 409);
    if (e instanceof AuthorityError) return json({ code: e.code, error: 'طلب فحص مصدر السوق غير صالح.' }, 409);
    return failure(e);
  }
}

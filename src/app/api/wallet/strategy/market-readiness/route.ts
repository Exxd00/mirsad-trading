import { z } from 'zod';
import { requireMutation, requireSession, refreshSessionCookie } from '@/lib/auth';
import { body, failure, json } from '@/lib/http';
import { AuthorityError } from '@/lib/wallet/authority';
import { readGnosisMarketReadiness, startGnosisMarketReadiness } from '@/lib/wallet/gnosis-market-readiness-job';
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
    if (!z.object({ chainId: z.literal(100) }).strict().safeParse(await body(request)).success) throw new AuthorityError('wallet_authority_request_invalid');
    const response = json({ ...await startGnosisMarketReadiness(), csrfToken: session.csrfToken });
    response.headers.append('Set-Cookie', await refreshSessionCookie(request, session));
    return response;
  } catch (e) {
    if (e instanceof AuthorityError) return json({ code: e.code, error: 'طلب فحص مصدر السوق غير صالح.' }, 409);
    return failure(e);
  }
}

import { z } from 'zod';
import { requireMutation, refreshSessionCookie } from '@/lib/auth';
import { body, failure, json } from '@/lib/http';
import { AuthorityError } from '@/lib/wallet/authority';
import { auditCowFeasibility } from '@/lib/wallet/cow-feasibility';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    const session = await requireMutation(request);
    const input = z.object({ owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/), chainId: z.literal(1) }).strict().safeParse(await body(request));
    if (!input.success) throw new AuthorityError('wallet_authority_request_invalid');
    const response = json({ ...await auditCowFeasibility(input.data.owner, input.data.chainId), csrfToken: session.csrfToken });
    response.headers.append('Set-Cookie', await refreshSessionCookie(request, session));
    return response;
  } catch (error) {
    if (error instanceof AuthorityError) return json({ code: error.code, error: 'تعذر إثبات الأرصدة والتكلفة الحالية. لم يُنشأ إعداد أو تفويض؛ أعد الفحص.' }, 409);
    return failure(error);
  }
}

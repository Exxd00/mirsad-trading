import { z } from 'zod';
import { requireMutation, refreshSessionCookie } from '@/lib/auth';
import { body, failure, json } from '@/lib/http';
import { AuthorityError } from '@/lib/wallet/authority';
import { prepareCowSetup } from '@/lib/wallet/cow-setup';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    const session = await requireMutation(request);
    const input = z.object({ action: z.literal('prepare'), owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/), chainId: z.literal(1) }).strict().safeParse(await body(request));
    if (!input.success) throw new AuthorityError('wallet_authority_request_invalid');
    const response = json({ ...await prepareCowSetup(input.data.owner, input.data.chainId), csrfToken: session.csrfToken });
    response.headers.append('Set-Cookie', await refreshSessionCookie(request, session));
    return response;
  } catch (error) {
    if (error instanceof AuthorityError) return json({ code: error.code, error: error.code === 'wallet_authority_feasibility_blocked'
      ? 'لم تثبت جدوى التنفيذ ضمن حد التكلفة 0.4%. افحص أصول المحفظة والتكلفة قبل أي تمويل أو توقيع.'
      : 'لم يكتمل إعداد الحساب. راجع حالة الشبكة والرصيد والمراجعة الحالية.' }, 409);
    return failure(error);
  }
}

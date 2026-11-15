import { z } from 'zod';
import { requireMutation, refreshSessionCookie } from '@/lib/auth';
import { body, failure, json } from '@/lib/http';
import { auditMusdValuation } from '@/lib/wallet/musd-valuation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    const session = await requireMutation(request);
    const input = z.object({ owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(v => !/^0x0{40}$/i.test(v)), chainId: z.literal(1) }).strict().safeParse(await body(request));
    if (!input.success) return json({ code: 'MUSD_VALUATION_INPUT', error: 'عنوان أو شبكة التقييم غير صالحين.' }, 400);
    const result = await auditMusdValuation(input.data.owner, input.data.chainId);
    const response = json({ ...result, csrfToken: session.csrfToken });
    response.headers.append('Set-Cookie', await refreshSessionCookie(request, session));
    return response;
  } catch (error) { return failure(error); }
}

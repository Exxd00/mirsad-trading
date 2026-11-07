import { z } from 'zod';
import { requireMutation, requireSession, refreshSessionCookie } from '@/lib/auth';
import { body, failure, json } from '@/lib/http';
import { authorizeTrial, draftTrial, pauseTrial, trialStatus } from '@/lib/wallet/trial-service';
import type { Hex } from 'viem';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform(v => v as Hex);
const change = z.discriminatedUnion('action', [
  z.object({ action: z.literal('draft'), terms: z.unknown() }).strict(),
  z.object({ action: z.literal('authorize'), id: z.uuid(), buy: signature, sell: signature }).strict(),
  z.object({ action: z.literal('pause'), id: z.uuid() }).strict(),
]);
export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    const response = json({ ...await trialStatus(), csrfToken: session.csrfToken });
    response.headers.append('Set-Cookie', await refreshSessionCookie(request, session));
    return response;
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    await requireMutation(request);
    const data = change.parse(await body(request));
    if (data.action === 'draft') return json(await draftTrial(data.terms));
    if (data.action === 'pause') return json(await pauseTrial(data.id));
    return json(await authorizeTrial(data.id, { buy: data.buy, sell: data.sell }));
  } catch (error) {
    if (error instanceof z.ZodError) return json({ error: 'تحقق من مبالغ التجربة ومدة التفويض.' }, 400);
    return failure(error);
  }
}

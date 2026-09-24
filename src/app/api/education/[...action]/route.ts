import { z } from 'zod';
import { requireMutation, requireSession, refreshSessionCookie } from '@/lib/auth';
import { json, failure, body } from '@/lib/http';
import { AppError } from '@/lib/errors';
import { initializeEducation, getEducationReport, setEducationEnabled } from '@/lib/education/store';
import { runEducation } from '@/lib/education/runner';
import { verifyScheduler } from '@/lib/education/scheduler-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ action: string[] }> };
const productionOnly = () => {
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') throw new AppError('EDUCATION_PREVIEW_DISABLED', 403, 'التنفيذ التعليمي متاح في الموقع الرئيسي فقط.');
};
export async function GET(request: Request, context: Context) {
  try {
    const session = await requireSession(request);
    if ((await context.params).action.join('/') !== 'report') return json({ error: 'المسار غير موجود.' }, 404);
    const response = json(await getEducationReport());
    response.headers.append('Set-Cookie', await refreshSessionCookie(request, session));
    return response;
  } catch (error) { return failure(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    productionOnly();
    const action = (await context.params).action.join('/');
    if (action === 'tick') {
      // Reject unauthenticated requests before reading any database state.
      if (!request.headers.get('authorization')?.startsWith('Mirsad-Ed25519 ') || Number(request.headers.get('content-length') || 0) > 512) return json({ error: 'authentication_required' }, 401);
      const data = await body(request), raw = JSON.stringify(data);
      if (!verifyScheduler(request, raw)) return json({ error: 'authentication_required' }, 401);
      const result = await runEducation();
      if ('busy' in result) return json({ ok: true, busy: true });
      return json({ ok: true, replayed: result.replayed, at: result.run?.at, status: result.run?.status, orders: result.run?.decisions.filter(d => d.orderId).length ?? 0 });
    }
    await requireMutation(request);
    const data = await body(request);
    if (action === 'setup') return json(await initializeEducation(data));
    if (action === 'settings') {
      const parsed = z.object({ enabled: z.boolean() }).strict().parse(data);
      return json(await setEducationEnabled(parsed.enabled));
    }
    if (action === 'run') {
      z.object({}).strict().parse(data);
      return json(await runEducation());
    }
    return json({ error: 'المسار غير موجود.' }, 404);
  } catch (error) {
    if (error instanceof z.ZodError) return json({ error: 'بيانات الطلب غير صالحة.', code: 'INVALID_EDUCATION_INPUT' }, 400);
    if (error instanceof Error && error.message === 'education_not_initialized') return json({ error: 'اعتمد الأرصدة الموجودة أولًا.', code: 'EDUCATION_NOT_INITIALIZED' }, 409);
    return failure(error);
  }
}

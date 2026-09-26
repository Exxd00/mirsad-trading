import { z } from 'zod';
import { requireMutation, requireSession, refreshSessionCookie } from '@/lib/auth';
import { json, failure, body } from '@/lib/http';
import { executionReport, runExecution } from '@/lib/execution/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Context = { params: Promise<{ action: string[] }> };

export async function GET(request: Request, context: Context) {
  try {
    const session = await requireSession(request);
    if ((await context.params).action.join('/') !== 'report') return json({ error: 'المسار غير موجود.' }, 404);
    const response = json(await executionReport());
    response.headers.append('Set-Cookie', await refreshSessionCookie(request, session));
    return response;
  } catch (error) { return failure(error); }
}

export async function POST(request: Request, context: Context) {
  try {
    await requireMutation(request);
    if ((await context.params).action.join('/') !== 'run') return json({ error: 'المسار غير موجود.' }, 404);
    if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') return json({ code: 'EXECUTION_PREVIEW_DISABLED', error: 'التشغيل غير متاح في نسخة المعاينة.' }, 403);
    z.object({}).strict().parse(await body(request));
    return json({ ...await runExecution(), error: 'مصدر الحساب التعليمي محدد؛ يلزم اكتمال بياناته وإشارات الدخول وموصل تنفيذ الأوامر قبل التشغيل.' }, 409);
  } catch (error) {
    if (error instanceof z.ZodError) return json({ code: 'INVALID_EXECUTION_INPUT', error: 'بيانات الطلب غير صالحة.' }, 400);
    return failure(error);
  }
}

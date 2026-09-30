import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { requireSession, requireMutation, refreshSessionCookie } from '@/lib/auth';
import { body, failure, json } from '@/lib/http';
import { discoveryReport, runDiscovery } from '@/lib/discovery/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ action: string[] }> };
function discoverySchedulerAuthorized(request: Request) {
  const secret = process.env.DISCOVERY_SCHEDULER_TOKEN;
  if (!secret || secret.length < 32) return false;
  const hash = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(hash(request.headers.get('authorization') ?? ''), hash(`Bearer ${secret}`));
}
export async function GET(request: Request, context: Context) {
  try {
    const session = await requireSession(request);
    if ((await context.params).action.join('/') !== 'report') return json({ error: 'المسار غير موجود.' }, 404);
    const result = json({ ...await discoveryReport(), csrfToken: session.csrfToken });
    result.headers.append('Set-Cookie', await refreshSessionCookie(request, session));
    return result;
  } catch (error) { return failure(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    const action = (await context.params).action.join('/');
    if (!['scan', 'tick'].includes(action)) return json({ error: 'المسار غير موجود.' }, 404);
    const session = action === 'scan' ? await requireMutation(request) : null;
    if (action === 'tick' && !discoverySchedulerAuthorized(request)) return json({ error: 'authentication_required' }, 401);
    z.object({}).strict().parse(await body(request));
    const result = await runDiscovery(action === 'tick' ? 'scheduler' : 'manual');
    if (result.status === 'busy' || result.status === 'throttled') return json({ status: result.status, error: 'الفحص الورقي قيد العمل أو أُجري قبل أقل من دقيقة.' }, 409, { 'Retry-After': '60' });
    return action === 'scan' ? json({ ...await discoveryReport(), csrfToken: session!.csrfToken }) : json(result, result.status === 'partial' ? 503 : 200);
  } catch (error) {
    if (error instanceof z.ZodError) return json({ error: 'بيانات الطلب غير صالحة.' }, 400);
    return failure(error);
  }
}

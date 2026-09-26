import { timingSafeEqual, createHash } from 'node:crypto';
import { z } from 'zod';
import { requireMutation, requireSession, refreshSessionCookie } from '@/lib/auth';
import { json, failure, body } from '@/lib/http';
import { executionReport, runExecution } from '@/lib/execution/service';
import { entrySwitch, handleDeadline, runTick } from '@/lib/execution/v1/host';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ action: string[] }> };
function schedulerAuthorized(request: Request) {
  const secret = process.env.EXECUTION_SCHEDULER_TOKEN;
  if (!secret) return false;
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(request.headers.get('authorization') ?? ''), hash(`Bearer ${secret}`));
}
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
    const action = (await context.params).action.join('/');
    if (action === 'tick' || action === 'deadline') {
      if (!schedulerAuthorized(request)) return json({ error: 'authentication_required' }, 401);
    } else await requireMutation(request);
    const data = await body(request);
    if (action === 'settings') return json(await entrySwitch(z.object({ entriesEnabled: z.boolean() }).strict().parse(data).entriesEnabled));
    if (action === 'deadline') {
      const parsed = z.object({ key: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(data);
      const result = await handleDeadline(parsed.key); return json(result, result.status === 'blocked' ? 409 : 200);
    }
    if (action !== 'run' && action !== 'tick') return json({ error: 'المسار غير موجود.' }, 404);
    z.object({}).strict().parse(data);
    const result = action === 'tick' ? await runTick() : await runExecution(); return json(result, result.status === 'blocked' ? 409 : 200);
  } catch (error) {
    if (error instanceof z.ZodError) return json({ code: 'INVALID_EXECUTION_INPUT', error: 'بيانات الطلب غير صالحة.' }, 400);
    return failure(error);
  }
}

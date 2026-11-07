import { timingSafeEqual, createHash } from 'node:crypto';
import { after } from 'next/server';
import { z } from 'zod';
import { requireMutation, requireSession, refreshSessionCookie } from '@/lib/auth';
import { json, failure, body } from '@/lib/http';
import { executionReport, runExecution } from '@/lib/execution/service';
import { entrySwitch, handleDeadline, runTick, runProtection, refreshReadiness } from '@/lib/execution/v1/host';

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
    const response = json({ ...await executionReport(), csrfToken: session.csrfToken });
    response.headers.append('Set-Cookie', await refreshSessionCookie(request, session));
    return response;
  } catch (error) { return failure(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    const action = (await context.params).action.join('/');
    if (action === 'tick' || action === 'deadline' || action === 'protect') {
      if (!schedulerAuthorized(request)) return json({ error: 'authentication_required' }, 401);
    } else await requireMutation(request);
    const data = await body(request);
    if (action === 'check') {
      z.object({}).strict().parse(data);
      return json(await refreshReadiness());
    }
    if (action === 'protect') {
      z.object({}).strict().parse(data);
      const result = await runProtection(); return json(result, result.status === 'blocked' ? 409 : 200);
    }
    if (action === 'settings') {
      const result = await entrySwitch(z.object({ entriesEnabled: z.boolean() }).strict().parse(data).entriesEnabled);
      return json(result, 'status' in result && result.status === 'blocked' ? 409 : 200);
    }
    if (action === 'deadline') {
      const parsed = z.object({ key: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(data);
      const result = await handleDeadline(parsed.key); return json(result, result.status === 'blocked' ? 409 : 200);
    }
    if (action !== 'run' && action !== 'tick') return json({ error: 'المسار غير موجود.' }, 404);
    z.object({}).strict().parse(data);
    if (action === 'tick' && process.env.VERCEL_ENV === 'production' && process.env.MIRSAD_WALLET_TESTNET_ENABLED !== 'false') {
      // Existing authenticated cron only. Test assets, ledger and signer are
      // independent of the live account and never change the legacy tick result.
      const trial = import('@/lib/wallet/trial-service').then(module => module.runWalletTrial()).catch(() => { console.warn('wallet_testnet_tick_unavailable'); });
      after(() => trial.then(() => undefined));
    }
    const result = action === 'tick' ? await runTick() : await runExecution(); return json(result, result.status === 'blocked' ? 409 : 200);
  } catch (error) {
    if (error instanceof z.ZodError) return json({ code: 'INVALID_EXECUTION_INPUT', error: 'بيانات الطلب غير صالحة.' }, 400);
    return failure(error);
  }
}

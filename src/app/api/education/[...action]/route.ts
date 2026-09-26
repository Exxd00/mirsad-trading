import { requireMutation, requireSession } from '@/lib/auth';
import { json, failure } from '@/lib/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Context = { params: Promise<{ action: string[] }> };
const retired = () => json({ status: 'retired', code: 'LEGACY_ENGINE_REMOVED', error: 'أزيل المحرك السابق. حالة البديل متاحة في صفحة الأتمتة.' }, 410);

export async function GET(request: Request) {
  try { await requireSession(request); return retired(); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request, context: Context) {
  // Retire even signed old cron requests without accessing state or providers.
  if ((await context.params).action.join('/') === 'tick') return retired();
  try { await requireMutation(request); return retired(); }
  catch (error) { return failure(error); }
}

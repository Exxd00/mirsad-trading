import { z } from 'zod';
import { requireMutation, requireSession, refreshSessionCookie } from '@/lib/auth';
import { body, failure, json } from '@/lib/http';
import { AppError } from '@/lib/errors';
import { walletStrategySetup } from '@/lib/wallet/strategy-setup';
import { saveOwnerStrategySelection } from '@/lib/wallet/selection-service';
import { StrategySelectionError } from '@/lib/wallet/strategy-selection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    const response = json(await walletStrategySetup());
    response.headers.append('Set-Cookie', await refreshSessionCookie(request, session));
    return response;
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    const session = await requireMutation(request);
    const input = z.object({ action: z.literal('set-selection'), mode: z.enum(['manual', 'opportunities']),
      expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1).nullable() }).strict().safeParse(await body(request));
    if (!input.success) throw new AppError('wallet_strategy_selection_invalid', 400, 'تحقق من طريقة اختيار الأسواق ثم أعد المحاولة.');
    await saveOwnerStrategySelection(input.data.mode, input.data.expectedRevision);
    const response = json(await walletStrategySetup());
    response.headers.append('Set-Cookie', await refreshSessionCookie(request, session));
    return response;
  } catch (error) {
    if (error instanceof StrategySelectionError) return json({ code: error.code, error: 'تغيّر إعداد اختيار الأسواق. حدّث الصفحة قبل إعادة الحفظ.' }, 409);
    return failure(error);
  }
}

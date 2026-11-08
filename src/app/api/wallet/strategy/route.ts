import { requireSession, refreshSessionCookie } from '@/lib/auth';
import { failure, json } from '@/lib/http';
import { walletStrategySetup } from '@/lib/wallet/strategy-setup';

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

import { NextResponse } from 'next/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Public build identity only: no account, grant, environment secret or storage. */
export function GET() {
  const value = process.env.VERCEL_GIT_COMMIT_SHA;
  return NextResponse.json({ version: 'cow-wallet-v1', commit: value && /^[0-9a-f]{40}$/.test(value) ? value : null },
    { headers: { 'Cache-Control': 'no-store' } });
}

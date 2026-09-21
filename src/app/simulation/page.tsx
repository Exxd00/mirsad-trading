import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/page-session';
import { TradingWorkspace } from '@/components/TradingWorkspace';
export const dynamic='force-dynamic';
export default async function Simulation(){const session=await pageSession();if(!session)redirect('/login');return <TradingWorkspace csrfToken={session.csrfToken} mode="simulation"/>;}

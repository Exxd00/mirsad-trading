import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/page-session';
import { TradingWorkspace } from '@/components/TradingWorkspace';
import { orderConnection } from '@/lib/order-connection';
export const dynamic='force-dynamic';
export default async function Page(){const session=await pageSession();if(!session)redirect('/login');if(orderConnection()!=='revolut-x')redirect('/wallet');return <TradingWorkspace csrfToken={session.csrfToken}/>;}

import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/page-session';
export const dynamic='force-dynamic';
export default async function Simulation(){const session=await pageSession();if(!session)redirect('/login');redirect('/');}


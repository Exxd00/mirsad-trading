import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/page-session';
export const dynamic='force-dynamic';
export default async function Page(){if(!await pageSession())redirect('/login');redirect('/wallet');}

import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/page-session';
import { LoginForm } from '@/components/LoginForm';
export const dynamic='force-dynamic';
export default async function Login(){const session=await pageSession().catch(()=>null);if(session)redirect('/');return <LoginForm csrfToken=""/>;}

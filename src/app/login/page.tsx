import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/page-session';
import { LoginForm } from '@/components/LoginForm';

export const dynamic = 'force-dynamic';

export default async function Login({ searchParams }: {
  searchParams: Promise<{ resume?: string | string[] }>;
}) {
  const destination = (await searchParams).resume === 'wallet' ? '/wallet' : '/';
  const session = await pageSession().catch(() => null);
  if (session) redirect(destination);
  return <LoginForm csrfToken="" destination={destination} />;
}

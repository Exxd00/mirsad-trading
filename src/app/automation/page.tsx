import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/page-session';
import { ExecutionWorkspace } from '@/components/ExecutionWorkspace';

export const dynamic = 'force-dynamic';

export default async function Automation() {
  const session = await pageSession();
  if (!session) redirect('/login');
  return <ExecutionWorkspace />;
}

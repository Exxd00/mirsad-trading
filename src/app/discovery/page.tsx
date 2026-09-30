import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/page-session';
import { DiscoveryWorkspace } from '@/components/DiscoveryWorkspace';

export const dynamic = 'force-dynamic';

export default async function Discovery() {
  const session = await pageSession();
  if (!session) redirect('/login');
  return <DiscoveryWorkspace />;
}

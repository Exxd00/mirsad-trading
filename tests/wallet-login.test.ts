import { describe, expect, it, vi } from 'vitest';
import Login from '../src/app/login/page';
import WalletPage from '../src/app/wallet/page';
import { pageSession } from '../src/lib/page-session';

vi.mock('../src/lib/page-session', () => ({ pageSession: vi.fn(async () => null) }));
vi.mock('../src/components/WalletConnection', () => ({ WalletConnection: () => null }));
vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error(path); } }));

describe('wallet login navigation', () => {
  it('sends an unauthenticated wallet visitor to login with the wallet marker', async () => {
    await expect(WalletPage()).rejects.toThrow(/^\/login\?resume=wallet$/);
  });

  it.each([
    { resume: 'wallet', destination: '/wallet' },
    { resume: undefined, destination: '/' },
    { resume: '//example.org', destination: '/' },
    { resume: ['wallet', '//example.org'], destination: '/' },
  ])('selects $destination for resume=$resume before and after login', async ({ resume, destination }) => {
    const props = { searchParams: Promise.resolve({ resume }) };
    expect((await Login(props)).props.destination).toBe(destination);
    vi.mocked(pageSession).mockResolvedValueOnce({ id: 'test', csrfToken: 'test', expiresAt: new Date(), authVersion: 1 });
    await expect(Login(props)).rejects.toThrow(new Error(destination));
  });
});

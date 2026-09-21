import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('next/headers',()=>({headers:vi.fn(async()=>new Headers({host:'untrusted.example','x-forwarded-host':'untrusted.example'}))}));
vi.mock('../src/lib/auth',()=>({getSession:vi.fn(async()=>null)}));
import { getSession } from '../src/lib/auth';
import { pageSession } from '../src/lib/page-session';

afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
describe('page session request construction',()=>{
  it.each(['','not a url','javascript:alert(1)','https://user:password@example.com'])('handles invalid or blank APP_ORIGIN without using request Host: %s',async value=>{
    vi.stubEnv('APP_ORIGIN',value);
    await expect(pageSession()).resolves.toBeNull();
    expect(vi.mocked(getSession).mock.calls[0][0].url).toBe('http://localhost:3000/');
  });
  it('uses a valid configured origin for cookie inspection',async()=>{
    vi.stubEnv('APP_ORIGIN','https://private.example');
    await pageSession();
    expect(vi.mocked(getSession).mock.calls[0][0].url).toBe('https://private.example/');
  });
});

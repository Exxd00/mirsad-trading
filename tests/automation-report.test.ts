import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {randomBytes,verify} from 'node:crypto';
vi.mock('server-only',()=>({}));
vi.mock('../src/lib/page-session',()=>({pageSession:vi.fn()}));
import {pageSession} from '../src/lib/page-session';
import {fetchMonitorReport,monitorPublicKey} from '../src/lib/automation-report';
import {closeDatabase,ensureSchema,query} from '../src/lib/db';
beforeAll(async()=>{vi.stubEnv('NODE_ENV','test');vi.stubEnv('VERCEL_ENV','');vi.stubEnv('DATABASE_URL','');vi.stubEnv('LOCAL_DATABASE_PATH','memory://');vi.stubEnv('ENCRYPTION_KEY',randomBytes(32).toString('base64'));await ensureSchema();});
beforeEach(async()=>{await query("DELETE FROM app_settings WHERE key='automation:monitor-signing:v1'");vi.mocked(pageSession).mockResolvedValue({id:'test'} as Awaited<ReturnType<typeof pageSession>>);vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({ok:true})));});
afterAll(async()=>{await closeDatabase();vi.unstubAllEnvs();vi.unstubAllGlobals();});
it('anonymous calls cannot create a key or obtain a report',async()=>{
  vi.mocked(pageSession).mockResolvedValue(null);
  await expect(fetchMonitorReport()).rejects.toThrow('Authentication required');
  await expect(monitorPublicKey()).rejects.toThrow('not been initialized');
  expect(fetch).not.toHaveBeenCalled();
});
it('creates an encrypted independent key and sends a valid short-lived report-only signature',async()=>{
  await fetchMonitorReport();
  const pub=await monitorPublicKey();expect(Object.keys(pub)).toEqual(['algorithm','publicKey']);
  const stored=(await query<{value:{privateKeyEncrypted:string}}>("SELECT value FROM app_settings WHERE key='automation:monitor-signing:v1'")).rows[0].value;
  expect(stored.privateKeyEncrypted.startsWith('v1.')).toBe(true);expect(stored.privateKeyEncrypted).not.toContain('PRIVATE KEY');
  const [url,options]=vi.mocked(fetch).mock.calls[0];expect(url).toBe('https://mirsad-signal-monitor.zenoura28.workers.dev/report');
  const bearer=new Headers(options?.headers).get('Authorization')!;
  const [payload,signature]=bearer.slice(7).split('.');
  expect(verify(null,Buffer.from(payload),pub.publicKey,Buffer.from(signature,'base64url'))).toBe(true);
  const claims=JSON.parse(Buffer.from(payload,'base64url').toString());expect(claims.exp-claims.iat).toBe(30);expect(claims.path).toBe('/report');
  await fetchMonitorReport();expect((await monitorPublicKey()).publicKey).toBe(pub.publicKey);
});

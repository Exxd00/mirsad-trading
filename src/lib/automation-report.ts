import 'server-only';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { query } from './db';
import { encryptSecret, decryptSecret } from './secrets';
import { pageSession } from './page-session';

const STORAGE_KEY='automation:monitor-signing:v1';
const CONTEXT='automation:monitor-report';
type SigningRecord={publicKey:string;privateKeyEncrypted:string};
async function storedKey(){
  const result=await query<{value:SigningRecord}>('SELECT value FROM app_settings WHERE key=$1',[STORAGE_KEY]);
  return result.rows[0]?.value;
}
// Public verification material only. Never initializes or returns a private key.
export async function monitorPublicKey(){
  const key=await storedKey();
  if(!key)throw new Error('Monitor reporting has not been initialized.');
  return {algorithm:'Ed25519',publicKey:key.publicKey};
}
export async function fetchMonitorReport(){
  if(!await pageSession())throw new Error('Authentication required.');
  if(process.env.VERCEL_ENV&&process.env.VERCEL_ENV!=='production')throw new Error('Monitor report is available in production only.');
  let record=await storedKey();
  if(!record){
    const generated=generateKeyPairSync('ed25519');
    const candidate={publicKey:generated.publicKey.export({type:'spki',format:'pem'}).toString(),privateKeyEncrypted:encryptSecret(generated.privateKey.export({type:'pkcs8',format:'pem'}).toString(),CONTEXT)};
    await query('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT DO NOTHING',[STORAGE_KEY,JSON.stringify(candidate)]);
    record=await storedKey();
  }
  if(!record)throw new Error('Monitor signing key is unavailable.');
  const now=Math.floor(Date.now()/1000);
  const payload=Buffer.from(JSON.stringify({aud:'mirsad-signal-monitor',path:'/report',iat:now,exp:now+30,nonce:randomUUID()})).toString('base64url');
  const signature=sign(null,Buffer.from(payload),decryptSecret(record.privateKeyEncrypted,CONTEXT)).toString('base64url');
  // Token stays server-side, expires in 30 seconds and grants report reads only.
  return fetch('https://mirsad-signal-monitor.zenoura28.workers.dev/report',{cache:'no-store',redirect:'error',headers:{Authorization:`Bearer ${payload}.${signature}`},signal:AbortSignal.timeout(15_000)});
}

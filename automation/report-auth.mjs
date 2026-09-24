import {createPublicKey,verify} from 'node:crypto';
export async function authorizedReport(request,fetcher=fetch,now=Date.now()){
  const header=request.headers.get('Authorization')??'';
  if(header.length>2048||!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(header))return false;
  try{
    const [payload,signature]=header.slice(7).split('.');
    const claims=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
    const seconds=Math.floor(now/1000);
    if(claims.aud!=='mirsad-signal-monitor'||claims.path!==new URL(request.url).pathname||!Number.isInteger(claims.iat)||!Number.isInteger(claims.exp)||claims.exp<=seconds||claims.iat>seconds+5||claims.exp-claims.iat>30||claims.exp<=claims.iat||typeof claims.nonce!=='string')return false;
    const response=await fetcher('https://mirsad-trading.vercel.app/api/automation/public-key',{method:'GET',redirect:'manual',signal:AbortSignal.timeout(8_000)});
    if(!response.ok)return false;
    const body=await response.text();if(body.length>1024)return false;
    const key=JSON.parse(body);
    if(key.algorithm!=='Ed25519'||typeof key.publicKey!=='string')return false;
    const publicKey=createPublicKey(key.publicKey);if(publicKey.asymmetricKeyType!=='ed25519')return false;
    return verify(null,Buffer.from(payload),publicKey,Buffer.from(signature,'base64url'));
  }catch{return false;}
}

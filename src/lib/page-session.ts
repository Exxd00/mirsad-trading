import 'server-only';
import { headers } from 'next/headers';
import { getSession } from './auth';
export async function pageSession(){
  // This URL only constructs a Request for cookie inspection. Mutation origin
  // authorization is independently enforced by auth.verifyOrigin; never derive
  // a trusted origin from caller-controlled Host/forwarding headers.
  let requestUrl='http://localhost:3000';
  try {
    const configured=new URL(process.env.APP_ORIGIN||requestUrl);
    if(['http:','https:'].includes(configured.protocol)&&!configured.username&&!configured.password)requestUrl=configured.origin;
  } catch { /* Empty/malformed deployment configuration still renders login. */ }
  return getSession(new Request(requestUrl,{headers:await headers()}));
}

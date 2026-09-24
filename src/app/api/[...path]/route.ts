import { z } from 'zod';
import { AuthError, changePassword, clearLoginCsrfCookie, clearSessionCookie, issueLoginCsrf, login, logout, refreshSessionCookie, requireMutation, requireSession, sessionCookie, verifyCurrentPassword } from '@/lib/auth';
import { json, failure, body } from '@/lib/http';
import { AppError } from '@/lib/errors';
import { audit, connectRevolut, createTradingPort, dashboard, instruments, market, setSetting, settings, toggleLive } from '@/lib/services';
import { confirmOrder, previewOrder, reconcileOrder } from '@/lib/trading';
import { monitorPublicKey } from '@/lib/automation-report';

export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=30;
type Context={params:Promise<{path:string[]}>};
export async function GET(request:Request,ctx:Context){
 let refreshedCookie:string|undefined;
 const respond=(response:Response)=>{
  if(refreshedCookie)response.headers.append('Set-Cookie',refreshedCookie);
  return response;
 };
 try{
  const path=(await ctx.params).path.join('/');
  if(path==='automation/public-key'){try{return json(await monitorPublicKey());}catch{return json({error:'Reporting is not initialized.'},503);}}
  if(path==='auth/csrf'){const csrf=issueLoginCsrf();const response=json({csrfToken:csrf.csrfToken});response.headers.append('Set-Cookie',csrf.cookie);return response;}
  const session=await requireSession(request);
  // Workspace reads and scheduled reads both keep the authenticated browser
  // session alive, including when an unrelated data provider is unavailable.
  refreshedCookie=await refreshSessionCookie(request,session);
  const url=new URL(request.url);
  switch(path){
   case 'session':return respond(json({csrfToken:session.csrfToken,expiresAt:session.expiresAt}));
   case 'dashboard':return respond(json(await dashboard(url.searchParams.get('mode')==='simulation'?'simulation':'live')));
   case 'market':return respond(json(await market(url.searchParams.get('symbol')??'BTC-EUR',Number(url.searchParams.get('interval')??15))));
   case 'settings':return respond(json(await settings()));
   default:return respond(json({error:'المسار غير موجود.'},404));
  }
 }catch(error){return respond(failure(error));}
}
export async function POST(request:Request,ctx:Context){
 try{
  const path=(await ctx.params).path.join('/');
  if(path==='auth/login'){
   const data=z.object({password:z.string().max(1024)}).safeParse(await body(request));if(!data.success)throw new AuthError(400,'invalid_input','أدخل كلمة المرور.');
   const result=await login(data.data.password,request);const response=json({ok:true});response.headers.append('Set-Cookie',sessionCookie(result.sessionToken,result.expiresAt));response.headers.append('Set-Cookie',clearLoginCsrfCookie());return response;
  }
  const session=await requireMutation(request);
  const data=await body(request);
  switch(path){
   case 'auth/logout':{await logout(request);const response=json({ok:true});response.headers.append('Set-Cookie',clearSessionCookie());return response;}
   case 'auth/password':{const p=z.object({currentPassword:z.string().max(1024),newPassword:z.string().min(12).max(1024)}).safeParse(data);if(!p.success)throw new AppError('INVALID_PASSWORD',400,'كلمة المرور الجديدة يجب أن تكون 12 حرفاً على الأقل.');await changePassword(request,p.data.currentPassword,p.data.newPassword);const response=json({ok:true});response.headers.append('Set-Cookie',clearSessionCookie());return response;}
   case 'watchlist':{const p=z.object({symbols:z.array(z.string()).max(30)}).safeParse(data);if(!p.success)throw new AppError('INVALID_WATCHLIST',400,'قائمة متابعة غير صالحة.');const available=await instruments();if(p.data.symbols.some(s=>!available.some(i=>i.symbol===s)))throw new AppError('INVALID_INSTRUMENT',400,'إحدى الأدوات غير مدعومة.');await setSetting('watchlist',[...new Set(p.data.symbols)]);return json({ok:true});}
   case 'settings/credentials':return json(await connectRevolut(data));
   case 'settings/live':{const p=z.object({enabled:z.boolean(),password:z.string().max(1024).optional(),acknowledged:z.boolean().optional()}).safeParse(data);if(!p.success)throw new AppError('INVALID_SETTINGS',400,'طلب غير صالح.');if(p.data.enabled&&(!p.data.acknowledged||!p.data.password||!await verifyCurrentPassword(p.data.password,request)))throw new AuthError(403,'reauth_required','يلزم تأكيد كلمة المرور والموافقة على تفعيل إرسال الأوامر.');return json(await toggleLive(p.data.enabled));}
   case 'orders/preview':return json(await previewOrder(data,session.id,createTradingPort()));
   case 'orders/confirm':return json(await confirmOrder(data,session.id,createTradingPort()));
   case 'orders/reconcile':{const p=z.object({intentId:z.uuid()}).safeParse(data);if(!p.success)throw new AppError('INVALID_ORDER',400,'معرّف غير صالح.');await audit('order.reconciliation_requested',{intentId:p.data.intentId});return json(await reconcileOrder(p.data.intentId,session.id,createTradingPort()));}
   default:return json({error:'المسار غير موجود.'},404);
  }
 }catch(error){return failure(error);}
}


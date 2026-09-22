import 'server-only';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { query, transaction } from './db';
import { AppError, fail } from './errors';

const positive = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/).max(40).refine(v=>new Decimal(v).gt(0));
export const draftSchema=z.object({accountId:z.enum(['revolut-x','simulation']),symbol:z.string().regex(/^[A-Z0-9]{2,16}-[A-Z0-9]{2,12}$/),side:z.enum(['buy','sell']),quantity:positive,type:z.enum(['market','limit']),limitPrice:positive.optional(),mode:z.enum(['live','simulation']).default('live'),scenario:z.enum(['fill','partial','reject','unknown']).default('fill'),idempotencyKey:z.uuid()});
export type Draft=z.infer<typeof draftSchema>;
export type NormalOrder={id:string;clientOrderId:string;symbol:string;side:string;type:string;quantity:string|null;filledQuantity:string;status:string;price?:string|null;createdAt:string;updatedAt?:string;fee?:string;feeCurrency?:string;mode?:string};
export type TradingContext={sessionId:string;accountId:string;credentialVersion:string;liveEnabled:boolean;readVerified:boolean;tradeAcknowledged:boolean;regionConfirmed:boolean;balances:{currency:string;available:string}[];instrument:{symbol:string;status:string;minQuantity?:string;maxQuantity?:string;quantityStep?:string;priceStep?:string;minNotional?:string};quote:{bid:number;ask:number;receivedAt:string;updatedAt:string;status:string;source:string}};
export interface TradingPort {
 context(draft:Draft,sessionId:string):Promise<TradingContext>;
 submit(draft:Draft,id:string):Promise<NormalOrder>;
 lookup(draft:Draft,id:string):Promise<NormalOrder|null>;
 identity?(draft:Draft,sessionId:string):Promise<Pick<TradingContext,'accountId'|'sessionId'|'credentialVersion'>>;
}
type StoredRequest={draft:Draft;sessionId:string;credentialVersion:string;summary:Record<string,unknown>};
type Intent={id:string;idempotency_key:string;account_id:string;request:StoredRequest;state:string;response:NormalOrder|null;expires_at:Date|string;confirmation_hash:string;created_at:Date|string};
function token(id:string,sessionId:string){const key=process.env.ENCRYPTION_KEY;if(!key)fail('NOT_CONFIGURED',503,'إعداد الحماية غير مكتمل.');return createHmac('sha256',key).update(`order-confirm:${sessionId}:${id}`).digest('base64url');}
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const same=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
// PostgreSQL JSONB reorders object fields. Equality must compare values, not the
// serialization insertion order, including on the first read after INSERT.
const canonicalDraft=(d:Draft)=>JSON.stringify(Object.keys(d).sort().map(key=>[key,d[key as keyof Draft]]));
function validateIdentity(d:Draft,c:Pick<TradingContext,'accountId'|'sessionId'|'credentialVersion'>,sessionId?:string){
 if(c.accountId!==d.accountId||!c.sessionId||sessionId&&c.sessionId!==sessionId)fail('ACCOUNT_MISMATCH',409,'بيانات الحساب أو الجلسة لا تطابق الأمر.');
 if(!c.credentialVersion)fail('PERMISSIONS_REQUIRED',403,'لم يتم التحقق من هوية الربط.');
}
function validateContext(d:Draft,c:TradingContext,sessionId?:string){
 validateIdentity(d,c,sessionId);
 if(d.mode==='simulation'&&d.accountId!=='simulation'||d.mode==='live'&&d.accountId!=='revolut-x')fail('ACCOUNT_MISMATCH',400,'الحساب لا يطابق بيئة الأمر.');
 if(d.mode==='live'){
  if(process.env.VERCEL_ENV&&process.env.VERCEL_ENV!=='production')fail('PREVIEW_LOCKED',403,'إرسال الأوامر غير متاح في نسخ المعاينة.');
  if(!c.liveEnabled)fail('LIVE_LOCKED',403,'إرسال أوامر الوسيط مقفول.');
  if(!c.readVerified||!c.tradeAcknowledged||!c.regionConfirmed)fail('PERMISSIONS_REQUIRED',403,'يجب التحقق من الربط ونطاق المفتاح والمنطقة أولاً.');
 }
 if(c.instrument.symbol!==d.symbol||!['active','tradable','online'].includes(c.instrument.status))fail('INSTRUMENT_UNAVAILABLE',400,'الأداة غير متاحة للتداول.');
 const price=d.type==='limit'?d.limitPrice:d.side==='buy'?c.quote.ask:c.quote.bid;
 if(!price||!Number.isFinite(Number(price)))fail('PRICE_REQUIRED',400,'السعر المطلوب غير متاح.');
 const now=Date.now(),received=Date.parse(c.quote.receivedAt),updated=Date.parse(c.quote.updatedAt);
 if(!['current','live'].includes(c.quote.status)||!Number.isFinite(received)||!Number.isFinite(updated)||now-received>15000||now-updated>30000||received>now+5000||updated>now+5000||!Number.isFinite(c.quote.bid)||!Number.isFinite(c.quote.ask)||!(c.quote.ask>0&&c.quote.bid>0&&c.quote.ask>=c.quote.bid))fail('STALE_QUOTE',409,'الأسعار قديمة أو غير صالحة؛ حدّث البيانات أولاً.');
 const q=new Decimal(d.quantity),p=new Decimal(price),notional=q.mul(p),fee=notional.mul('0.0009');
 if(d.type==='limit'&&!d.limitPrice)fail('LIMIT_REQUIRED',400,'أدخل سعر الأمر المحدد.');
 for(const [value,step,label] of [[q,c.instrument.quantityStep,'الكمية'],[p,d.type==='limit'?c.instrument.priceStep:undefined,'السعر']] as const){if(step&&new Decimal(step).gt(0)&&!value.mod(step).eq(0))fail('INVALID_INCREMENT',400,`${label} لا يطابق خطوة الوسيط.`);}
 if(c.instrument.minQuantity&&q.lt(c.instrument.minQuantity)||c.instrument.minNotional&&notional.lt(c.instrument.minNotional))fail('BELOW_MINIMUM',400,'قيمة الأمر أقل من الحد الأدنى للوسيط.');
 if(c.instrument.maxQuantity&&q.gt(c.instrument.maxQuantity))fail('ABOVE_MAXIMUM',400,'الكمية أعلى من الحد الأقصى للوسيط.');
 if(notional.gt('1000000'))fail('ABOVE_MAXIMUM',400,'قيمة الأمر تتجاوز الحد الأقصى البالغ مليون وحدة من عملة التسعير.');
 const [base,quote]=d.symbol.split('-');
 const currency=d.side==='buy'?quote:base;
 const available=c.balances.find(b=>b.currency===currency)?.available;
 if(available===undefined)fail('BALANCE_UNAVAILABLE',409,'الرصيد المتاح لهذا الأصل غير متحقق.');
 const need=d.side==='buy'?notional.add(fee):q;
 if(new Decimal(available).lt(need))fail('INSUFFICIENT_BALANCE',400,'الرصيد المتاح غير كافٍ. لا توجد رافعة أو تحويل أموال تلقائي.');
 return {accountId:d.accountId,symbol:d.symbol,side:d.side,type:d.type,quantity:d.quantity,price:String(price),limitPrice:d.limitPrice??null,timeInForce:d.type==='market'?'افتراضي الوسيط':'GTC',estimatedNotional:notional.toFixed(8),estimatedFee:fee.toFixed(8),estimatedTotal:(d.side==='buy'?notional.add(fee):notional.sub(fee)).toFixed(8),currency:quote,feeRate:'0.09%',feeNote:'تقدير محافظ للتنفيذ الآخذ للسيولة؛ الرسوم النهائية من سجل الوسيط.',priceSource:c.quote.source,quoteAt:c.quote.updatedAt,warning:d.type==='market'?'السعر والتكلفة تقديريان وقد يتغير سعر التنفيذ.':'قد ينفذ الأمر جزئياً أو يبقى مفتوحاً حتى التنفيذ أو الإلغاء في منصة الوسيط.',mode:d.mode};
}
function previewResponse(i:Intent){return {intentId:i.id,confirmationToken:token(i.id,i.request.sessionId),expiresAt:new Date(i.expires_at).toISOString(),summary:i.request.summary,mode:i.request.draft.mode,state:i.state};}
export async function previewOrder(raw:unknown,sessionId:string,port:TradingPort){
 const parsed=draftSchema.safeParse(raw);if(!parsed.success)fail('INVALID_ORDER',400,'تحقق من الحقول والكمية ونوع الأمر.');const draft=parsed.data;
 const prior=(await query<Intent>('SELECT * FROM order_intents WHERE idempotency_key=$1',[draft.idempotencyKey])).rows[0];
 if(prior){if(prior.request.sessionId!==sessionId||canonicalDraft(prior.request.draft)!==canonicalDraft(draft))fail('IDEMPOTENCY_CONFLICT',409,'معرّف المحاولة مستخدم لأمر آخر.');return previewResponse(prior);}
 const unresolved=await query("SELECT id FROM order_intents WHERE account_id=$1 AND state IN ('SUBMITTING','UNKNOWN') LIMIT 1",[draft.accountId]);
 if(unresolved.rowCount)fail('UNRESOLVED_ORDER',409,'يوجد إرسال غير محسوم لهذا الحساب. راجع حالته قبل أمر جديد.');
 const context=await port.context(draft,sessionId),summary=validateContext(draft,context,sessionId);
 const id=randomUUID(),confirmationHash=digest(token(id,sessionId)),expiresAt=new Date(Date.now()+60000);
 const request:StoredRequest={draft,sessionId,credentialVersion:context.credentialVersion,summary};
 await query(`INSERT INTO order_intents(id,idempotency_key,broker,account_id,instrument,request,state,confirmation_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,'PREVIEW',$7,$8) ON CONFLICT(idempotency_key) DO NOTHING`,[id,draft.idempotencyKey,draft.mode==='simulation'?'simulation':'revolut-x',draft.accountId,draft.symbol,JSON.stringify(request),confirmationHash,expiresAt]);
 const saved=(await query<Intent>('SELECT * FROM order_intents WHERE idempotency_key=$1',[draft.idempotencyKey])).rows[0];
 if(saved.request.sessionId!==sessionId||canonicalDraft(saved.request.draft)!==canonicalDraft(draft))fail('IDEMPOTENCY_CONFLICT',409,'معرّف المحاولة مستخدم لأمر آخر.');
 return previewResponse(saved);
}
export async function confirmOrder(raw:unknown,sessionId:string,port:TradingPort){
 const data=z.object({intentId:z.uuid(),confirmationToken:z.string().min(32).max(128),acknowledged:z.literal(true)}).safeParse(raw);if(!data.success)fail('CONFIRMATION_REQUIRED',400,'يلزم تأكيد صريح لملخص الأمر.');
 let intent=(await query<Intent>('SELECT * FROM order_intents WHERE id=$1',[data.data.intentId])).rows[0];
 if(!intent||intent.request.sessionId!==sessionId)fail('ORDER_NOT_FOUND',404,'الأمر غير موجود في هذه الجلسة.');
 if(!same(intent.confirmation_hash,digest(data.data.confirmationToken)))fail('CONFIRMATION_INVALID',403,'رمز التأكيد غير صالح.');
 if(intent.state!=='PREVIEW')return {intentId:intent.id,state:intent.state,order:intent.response,replayed:true};
 if(new Date(intent.expires_at).getTime()<Date.now())fail('PREVIEW_EXPIRED',409,'انتهت صلاحية الملخص؛ أنشئ مراجعة جديدة.');
 const context=await port.context(intent.request.draft,sessionId);
 const refreshedSummary=validateContext(intent.request.draft,context,sessionId);
 if(context.credentialVersion!==intent.request.credentialVersion)fail('ACCOUNT_CHANGED',409,'تغير ربط الحساب منذ مراجعة الأمر.');
 if(intent.request.draft.type==='market'){
  const reviewedPrice=new Decimal(String(intent.request.summary.price));
  if(new Decimal(refreshedSummary.price).sub(reviewedPrice).abs().div(reviewedPrice).gt('0.005'))fail('PRICE_CHANGED',409,'تغير السعر بأكثر من 0.5% منذ المراجعة؛ أنشئ ملخصًا جديدًا. هذا الفحص لا يضمن سعر التنفيذ.');
 }
 const shouldSend=await transaction(async tx=>{
  // All intents for one account share a lock, including different preview IDs.
  const accountLock=`order_account_lock:${intent.account_id}`;
  await tx.query("INSERT INTO app_settings(key,value) VALUES($1,'false'::jsonb) ON CONFLICT(key) DO NOTHING",[accountLock]);
  await tx.query('SELECT value FROM app_settings WHERE key=$1 FOR UPDATE',[accountLock]);
  const current=(await tx.query<Intent>('SELECT * FROM order_intents WHERE id=$1 FOR UPDATE',[intent.id])).rows[0];
  if(current.state!=='PREVIEW'){intent=current;return false;}
  const unresolved=await tx.query("SELECT id FROM order_intents WHERE account_id=$1 AND id<>$2 AND state IN ('SUBMITTING','UNKNOWN') LIMIT 1",[intent.account_id,intent.id]);
  if(unresolved.rowCount)fail('UNRESOLVED_ORDER',409,'يوجد إرسال غير محسوم لهذا الحساب. استعلم عن نتيجته قبل إرسال أمر آخر.');
  if(new Date(current.expires_at).getTime()<Date.now())fail('PREVIEW_EXPIRED',409,'انتهت صلاحية الملخص.');
  if(current.request.draft.mode==='live'){
   const gate=(await tx.query<{value:boolean}>("SELECT value FROM app_settings WHERE key='live_enabled' FOR UPDATE")).rows[0];
   if(gate?.value!==true)fail('LIVE_LOCKED',403,'تم تعطيل إرسال الأوامر الجديدة.');
  }
  await tx.query("UPDATE order_intents SET state='SUBMITTING',attempt_started_at=NOW(),updated_at=NOW() WHERE id=$1",[intent.id]);
  await tx.query('INSERT INTO audit_events(event,detail) VALUES($1,$2)',['order_submission_started',JSON.stringify({intentId:intent.id,accountId:intent.account_id,mode:intent.request.draft.mode})]);
  return true;
 });
 if(!shouldSend)return {intentId:intent.id,state:intent.state,order:intent.response,replayed:true};
 try{
  const order=await port.submit(intent.request.draft,intent.id);
  await query('UPDATE order_intents SET state=$2,broker_order_id=$3,response=$4,updated_at=NOW() WHERE id=$1',[intent.id,order.status,order.id,JSON.stringify(order)]);
  return {intentId:intent.id,state:order.status,order,replayed:false};
 }catch(error){
  // Any uncertain transport/server outcome is durably frozen. Only a definitive broker rejection is terminal.
  const definitive=error instanceof AppError&&error.code==='BROKER_REJECTED';
  const state=definitive?'REJECTED':'UNKNOWN';
  await query('UPDATE order_intents SET state=$2,updated_at=NOW() WHERE id=$1',[intent.id,state]);
  return {intentId:intent.id,state,order:null,message:definitive?'رفض الوسيط الأمر.':'نتيجة الإرسال غير محسومة. استخدم الاستعلام؛ لن يعاد الإرسال تلقائياً.'};
 }
}
export async function reconcileOrder(id:string,sessionId:string,port:TradingPort){
 if(!z.uuid().safeParse(id).success)fail('INVALID_ID',400,'معرّف غير صالح.');
 const intent=(await query<Intent>('SELECT * FROM order_intents WHERE id=$1',[id])).rows[0];
 // This application has exactly one owner. A newly authenticated owner session
 // may reconcile an older intent after logout/expiry; submission confirmation
 // remains bound to its original session above. The route enforces active auth.
 if(!intent)fail('ORDER_NOT_FOUND',404,'الأمر غير موجود.');
 if(intent.state==='PREVIEW')return {intentId:id,state:'PREVIEW',order:null};
 const identity=port.identity?await port.identity(intent.request.draft,sessionId):await port.context(intent.request.draft,sessionId);
 validateIdentity(intent.request.draft,identity,sessionId);
 if(identity.credentialVersion!==intent.request.credentialVersion)fail('ACCOUNT_CHANGED',409,'تغير ربط الحساب؛ لا يمكن إسناد نتيجة هذا الأمر إلى الربط الجديد.');
 const order=await port.lookup(intent.request.draft,id);
 if(order){await query('UPDATE order_intents SET state=$2,broker_order_id=$3,response=$4,updated_at=NOW() WHERE id=$1',[id,order.status,order.id,JSON.stringify(order)]);return {intentId:id,state:order.status,order};}
 return {intentId:id,state:intent.state,order:intent.response,message:'لم يُعثر على نتيجة مؤكدة بعد. لا تعِد إرسال الأمر؛ تحقق من منصة الوسيط.'};
}
export { validateContext };

